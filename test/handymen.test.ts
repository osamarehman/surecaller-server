import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  createHarness,
  registerAdmin,
  registerMember,
  type Harness,
} from "./helpers.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

describe("handyman directory", () => {
  it("lists by city and category, merges duplicates, and averages one review per member", async () => {
    const a = await registerAdmin(h, "+923001110001", "Ali Khan");
    const b = await registerMember(h, a, "+923001110002", "Sara Khan");

    expect((await api(h, "GET", "/v1/handymen/cities")).status).toBe(401);
    const add = (body: object) => api(h, "POST", "/v1/handymen", a.token, body);
    const plumber = await add({
      name: "Bashir Plumbing",
      phone: "0300 2223334",
      city: " lahore ",
      category: "plumber",
    });
    expect(plumber.status).toBe(201);
    expect(plumber.body).toMatchObject({
      phone: "+923002223334",
      city: "Lahore",
      category: "Plumber",
      rating: null,
      ratingCount: 0,
    });
    const again = await add({
      name: "Other name",
      phone: "+923002223334",
      city: "Lahore",
      category: "Plumber",
    });
    expect(again).toMatchObject({
      status: 200,
      body: { id: plumber.body.id, name: "Bashir Plumbing" },
    });
    await add({
      name: "Waheed AC",
      phone: "03004445556",
      city: "Lahore",
      category: "ac technician",
    });
    await add({
      name: "Karachi Sparks",
      phone: "03006667778",
      city: "Karachi",
      category: "Solar fitter",
    });
    expect(
      (
        await add({
          name: "x",
          phone: "1",
          city: "Lahore",
          category: "Plumber",
        })
      ).status,
    ).toBe(400);

    expect(
      (await api(h, "GET", "/v1/handymen/cities", b.token)).body.cities,
    ).toEqual([
      { name: "Lahore", count: 2 },
      { name: "Karachi", count: 1 },
    ]);
    expect(
      (
        await api(h, "GET", "/v1/handymen/categories?city=lahore", b.token)
      ).body.categories.map((c: { name: string }) => c.name),
    ).toEqual(["AC Technician", "Plumber"]);
    const both = await api(
      h,
      "GET",
      "/v1/handymen?city=Lahore&category=Plumber&category=AC%20Technician",
      b.token,
    );
    expect(both.body.handymen).toHaveLength(2);
    expect(
      (
        await api(
          h,
          "GET",
          "/v1/handymen?city=Lahore&category=Plumber",
          b.token,
        )
      ).body.handymen,
    ).toHaveLength(1);

    const id = plumber.body.id;
    await api(h, "PUT", `/v1/handymen/${id}/review`, a.token, {
      rating: 5,
      text: "Fixed it fast",
      author: "Ali",
    });
    await api(h, "PUT", `/v1/handymen/${id}/review`, b.token, { rating: 1 });
    const redo = await api(h, "PUT", `/v1/handymen/${id}/review`, b.token, {
      rating: 4,
      text: "Good",
    });
    expect(redo.body.handyman).toMatchObject({ rating: 4.5, ratingCount: 2 });
    expect(
      (await api(h, "PUT", `/v1/handymen/${id}/review`, b.token, { rating: 6 }))
        .status,
    ).toBe(400);

    const detail = (await api(h, "GET", `/v1/handymen/${id}`, b.token)).body;
    expect(detail.reviews).toMatchObject([
      { rating: 4, text: "Good", author: null, mine: true },
      { rating: 5, text: "Fixed it fast", author: "Ali", mine: false },
    ]);
    expect(JSON.stringify(detail)).not.toContain(a.user.id);

    const top = await api(h, "GET", "/v1/handymen?city=Lahore", b.token);
    expect(top.body.handymen[0].id).toBe(id);

    expect(
      (await api(h, "DELETE", `/v1/handymen/${id}/review`, b.token)).status,
    ).toBe(204);
    expect(
      (await api(h, "GET", `/v1/handymen/${id}`, a.token)).body.handyman,
    ).toMatchObject({ rating: 5, ratingCount: 1 });
    expect(
      (await api(h, "GET", "/v1/handymen/not-a-uuid", a.token)).status,
    ).toBe(404);
  });
});
