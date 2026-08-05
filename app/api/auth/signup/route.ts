import { randomUUID } from "node:crypto";

import { hash } from "bcryptjs";
import { z } from "zod";

import { isAuthenticationEnabled } from "@/lib/server/auth-settings";
import { getDatabase } from "@/lib/server/db/client";
import { users } from "@/lib/server/db/schema";

export const runtime = "nodejs";

const signupSchema = z.object({
  email: z.email().transform((email) => email.trim().toLowerCase()),
  password: z.string().min(8).max(200),
});

export async function POST(request: Request) {
  if (!isAuthenticationEnabled()) {
    return Response.json({ error: "Authentication is not enabled." }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Response.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    throw error;
  }

  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Enter a valid email and a password of at least 8 characters." }, { status: 400 });
  }

  const inserted = await getDatabase()
    .insert(users)
    .values({
      id: randomUUID(),
      email: parsed.data.email,
      passwordHash: await hash(parsed.data.password, 12),
    })
    .onConflictDoNothing()
    .returning({ id: users.id });
  if (inserted.length === 0) {
    return Response.json({ error: "Unable to create account with those credentials." }, { status: 409 });
  }

  return Response.json({ created: true }, { status: 201 });
}
