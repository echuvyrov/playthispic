import test from "node:test";
import assert from "node:assert/strict";
import { createSupportCheckout } from "../server/local-server.mjs";

test("support checkout rejects amounts outside the published options", async () => {
  await assert.rejects(
    () => createSupportCheckout({ amount: 2 }),
    (error) => error.status === 400 && /\$1, \$3, \$5, or \$10/.test(error.message)
  );
});

test("support checkout reports missing Stripe configuration", async (t) => {
  const existingKey = process.env.STRIPE_SECRET_KEY;
  const existingSite = process.env.NEXT_PUBLIC_SITE_URL;
  delete process.env.STRIPE_SECRET_KEY;
  process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:5174";
  t.after(() => {
    if (existingKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = existingKey;
    if (existingSite === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = existingSite;
  });

  await assert.rejects(
    () => createSupportCheckout({ amount: 3 }),
    (error) => error.status === 503 && /Stripe support/.test(error.message)
  );
});
