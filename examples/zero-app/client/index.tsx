import type { ComponentChildren } from "preact";
import { Link, SignInWithSpacefast, signOut, useAuth, useQuery } from "@spacefast/zero/client";
import { Badge, Button, Spinner } from "@spacefast/zero/kit";
import { type Entitlements, isPro } from "../shared/plans";

function PlanBadge() {
  const entitlements = useQuery<Entitlements>("entitlements");
  return isPro(entitlements) ? <Badge tone="success">Pro</Badge> : <Badge>Free</Badge>;
}

function AuthControls() {
  const auth = useAuth();
  if (auth.isLoading) return <Spinner size="sm" />;
  if (!auth.isSignedIn) return <SignInWithSpacefast />;
  return (
    <div class="flex items-center gap-2">
      <PlanBadge />
      <span class="text-sm text-ink-muted">{auth.email ?? auth.displayName}</span>
      <Button variant="ghost" size="sm" onClick={() => signOut()}>
        Sign out
      </Button>
    </div>
  );
}

export function Layout({ children }: { children: ComponentChildren }) {
  return (
    <main class="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-4 p-6">
      <header class="flex flex-wrap items-center justify-between gap-4">
        <nav class="flex gap-4 text-sm font-medium">
          <Link to="/" class="text-ink hover:text-accent">Notes</Link>
          <Link to="/billing" class="text-ink hover:text-accent">Billing</Link>
          <Link to="/debug" class="text-ink hover:text-accent">Debug</Link>
        </nav>
        <AuthControls />
      </header>
      {children}
    </main>
  );
}
