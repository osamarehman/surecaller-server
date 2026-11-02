import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Client } from "../db.js";
import { conflict, notFound } from "../errors.js";
import { parse, userKey } from "../http.js";
import { requirePhone } from "../phone.js";
import { UUID_RE } from "../users.js";
import { vault } from "../vault.js";

// Shared handyman directory, contract in docs/HANDYMAN.md.

const BUILT_IN = [
  "Electrician",
  "Plumber",
  "Carpenter",
  "Painter",
  "AC Technician",
  "Mechanic",
  "Mason",
  "Welder",
  "Cleaner",
];
const CANON = new Map(BUILT_IN.map((c) => [c.toLowerCase(), c]));

/** "  lahore   cantt " -> "Lahore Cantt"; built-in categories keep their spelling ("AC Technician"). */
export const tidy = (s: string) => {
  const t = s
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(
      /(^|[\s(/-])(\p{L})/gu,
      (_m, a: string, b: string) => a + b.toUpperCase(),
    );
  return CANON.get(t.toLowerCase()) ?? t;
};

const label = z.string().trim().min(2).max(40).transform(tidy);
const NewHandyman = z.object({
  name: z.string().trim().min(2).max(60),
  phone: z.string(),
  city: label,
  category: label,
});
const ListQuery = z.object({
  city: label,
  category: z.union([label, z.array(label)]).optional(),
  sort: z.enum(["rating", "new"]).optional().default("rating"),
});
const Review = z.object({
  rating: z.number().int().min(1).max(5),
  text: z.string().trim().max(500).optional().default(""),
  author: z.string().trim().max(60).nullish(),
});

interface Row {
  id: string;
  name: string;
  phone: string;
  city: string;
  category: string;
  rating: string | null;
  rating_count: number;
  created_at: Date;
}

// ponytail: ratings are averaged per read, add rating columns if a city lists thousands
const SELECT = `SELECT h.*, round(avg(r.rating), 1) AS rating, count(r.rating)::int AS rating_count
  FROM handymen h LEFT JOIN handyman_reviews r ON r.handyman_id = h.id`;

const toHandyman = (r: Row) => ({
  id: r.id,
  name: r.name,
  phone: r.phone,
  city: r.city,
  category: r.category,
  rating: r.rating === null ? null : Number(r.rating),
  ratingCount: r.rating_count,
  createdAt: r.created_at.toISOString(),
});

async function getHandyman(db: Client, id: string) {
  if (!UUID_RE.test(id)) throw notFound("Handyman not found");
  const { rows } = await db.query<Row>(
    `${SELECT} WHERE h.id = $1 GROUP BY h.id`,
    [id],
  );
  if (!rows[0]) throw notFound("Handyman not found");
  return toHandyman(rows[0]);
}

export async function handymanRoutes(app: FastifyInstance) {
  const { pool, cfg } = app.ctx;

  app.get("/handymen/cities", async () => {
    const { rows } = await pool.query(
      "SELECT city AS name, count(*)::int AS count FROM handymen GROUP BY city ORDER BY count DESC, city",
    );
    return { cities: rows };
  });

  app.get("/handymen/categories", async (req) => {
    const { city } = parse(z.object({ city: label }), req.query);
    const { rows } = await pool.query(
      `SELECT category AS name, count(*)::int AS count FROM handymen WHERE city = $1
       GROUP BY category ORDER BY count DESC, category`,
      [city],
    );
    return { categories: rows };
  });

  app.get("/handymen", async (req) => {
    const q = parse(ListQuery, req.query);
    const cats = q.category === undefined ? null : [q.category].flat();
    const { rows } = await pool.query<Row>(
      `${SELECT} WHERE h.city = $1 AND ($2::text[] IS NULL OR h.category = ANY($2))
       GROUP BY h.id ORDER BY ${q.sort === "new" ? "h.created_at DESC" : "rating DESC NULLS LAST, rating_count DESC, h.created_at DESC"}
       LIMIT 200`,
      [q.city, cats],
    );
    return { handymen: rows.map(toHandyman) };
  });

  app.post(
    "/handymen",
    {
      config: {
        rateLimit: { max: 20, timeWindow: "1 hour", keyGenerator: userKey },
      },
    },
    async (req, reply) => {
      const b = parse(NewHandyman, req.body);
      const phone = requirePhone(b.phone, cfg.defaultRegion);
      const out = await pool.query(
        "SELECT 1 FROM opt_outs WHERE phone_hash = $1",
        [vault().index(phone)],
      );
      if (out.rowCount)
        throw conflict("opted_out", "This number asked not to be listed");
      const { rows } = await pool.query<{ id: string; created: boolean }>(
        `INSERT INTO handymen (name, phone, city, category, added_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (phone, city, category) DO UPDATE SET phone = EXCLUDED.phone
         RETURNING id, (xmax = 0) AS created`,
        [b.name, phone, b.city, b.category, req.user.id],
      );
      return reply
        .status(rows[0].created ? 201 : 200)
        .send(await getHandyman(pool, rows[0].id));
    },
  );

  app.get<{ Params: { id: string } }>("/handymen/:id", async (req) => {
    const handyman = await getHandyman(pool, req.params.id);
    const { rows } = await pool.query(
      `SELECT rating, text, author, created_at, user_id = $2 AS mine FROM handyman_reviews
       WHERE handyman_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.params.id, req.user.id],
    );
    const reviews = rows.map((r) => ({
      rating: r.rating,
      text: r.text,
      author: r.author,
      createdAt: r.created_at.toISOString(),
      mine: r.mine,
    }));
    return { handyman, reviews };
  });

  const reviewLimit = {
    config: {
      rateLimit: { max: 30, timeWindow: "1 hour", keyGenerator: userKey },
    },
  };

  app.put<{ Params: { id: string } }>(
    "/handymen/:id/review",
    reviewLimit,
    async (req) => {
      await getHandyman(pool, req.params.id);
      const b = parse(Review, req.body);
      const { rows } = await pool.query(
        `INSERT INTO handyman_reviews (handyman_id, user_id, rating, text, author) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (handyman_id, user_id) DO UPDATE SET rating = $3, text = $4, author = $5, created_at = now()
       RETURNING rating, text, author, created_at`,
        [req.params.id, req.user.id, b.rating, b.text, b.author || null],
      );
      const r = rows[0];
      return {
        handyman: await getHandyman(pool, req.params.id),
        review: {
          rating: r.rating,
          text: r.text,
          author: r.author,
          createdAt: r.created_at.toISOString(),
          mine: true,
        },
      };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/handymen/:id/review",
    reviewLimit,
    async (req, reply) => {
      await getHandyman(pool, req.params.id);
      await pool.query(
        "DELETE FROM handyman_reviews WHERE handyman_id = $1 AND user_id = $2",
        [req.params.id, req.user.id],
      );
      return reply.status(204).send();
    },
  );
}
