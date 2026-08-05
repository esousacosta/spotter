import { SpotterApp } from "@/app/components/spotter-app";
import { auth } from "@/auth";
import { isAuthenticationEnabled } from "@/lib/server/auth-settings";

export default async function Home() {
  const authenticationEnabled = isAuthenticationEnabled();
  const session = authenticationEnabled ? await auth() : null;

  return (
    <SpotterApp
      authenticationEnabled={authenticationEnabled}
      user={session?.user ? { email: session.user.email ?? null } : null}
    />
  );
}
