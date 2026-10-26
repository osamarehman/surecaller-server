-- Public feedback board (site/feedback.html, docs/FEEDBACK.md). No IPs stored.
CREATE TABLE feedback (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text NOT NULL CHECK (type IN ('bug', 'feature')),
  title         text NOT NULL,
  description   text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'planned', 'in_progress', 'shipped', 'rejected')),
  reject_reason text,
  author        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE TABLE feedback_votes (
  feedback_id uuid NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  voter_id    text NOT NULL,
  PRIMARY KEY (feedback_id, voter_id)
);
