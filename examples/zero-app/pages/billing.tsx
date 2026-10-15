"use client";

import { authenticatedFetch, useAction, useAuth, useQuery } from "@spacefast/zero/client";
import { Alert, Badge, Button, Card, EmptyState } from "@spacefast/zero/kit";
import { useEffect, useState } from "preact/hooks";
import { CONFIG_READS_METER_ID, type Entitlements, isPro, PRO_PRODUCT_ID } from "../shared/plans";

export default function BillingPage() {
  const auth = useAuth();
  const entitlements = useQuery<Entitlements>("entitlements");
  const recordUsage = useAction<[reads: number], { inserted: number }>("recordUsage");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pro = isPro(entitlements);
  const subscription = entitlements?.subscriptions.find((item) => item.productId === PRO_PRODUCT_ID);
  const meter = entitlements?.meters.find((item) => item.meterId === CONFIG_READS_METER_ID);

  async function sync() {
    setBusy(true);
    try {
      // Zero only accepts cookie-authenticated writes with a non-safelisted content type.
      const response = await authenticatedFetch("/api/polar/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      setMessage(response.ok ? "Refreshed from Polar." : `Refresh failed: ${response.status} ${await response.text()}`);
    } finally {
      setBusy(false);
    }
  }

  // Coming back from checkout: read through to Polar instead of waiting for the webhook.
  useEffect(() => {
    if (auth.isSignedIn && new URLSearchParams(window.location.search).has("checkout_id")) {
      setMessage("Payment received. Syncing your plan…");
      void sync();
    }
  }, [auth.isSignedIn]);

  async function useApi() {
    setBusy(true);
    try {
      const result = await recordUsage(5_000_000);
      setMessage(
        `Reported 5M config reads to Polar (${result.inserted} event). Polar tallies usage in the background, so the balance updates here on its own within a few minutes.`,
      );
    } catch (error) {
      setMessage(`Usage failed: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  if (!auth.isLoading && !auth.isSignedIn) {
    return (
      <Card title="Billing">
        <EmptyState title="Signed out" description="Sign in with Spacefast to see your plan." />
      </Card>
    );
  }

  return (
    <div class="flex flex-col gap-4">
      {message ? <Alert tone="info">{message}</Alert> : null}

      <Card
        title={pro ? "You're on Pro" : "Free plan"}
        subtitle={pro ? "Polar sandbox subscription, kept in sync by webhooks." : "Upgrade with Polar's sandbox checkout. Use card 4242 4242 4242 4242."}
        footer={pro ? <Badge tone="success">Pro</Badge> : <Badge>Free</Badge>}
      >
        {subscription ? (
          <dl class="grid grid-cols-2 gap-2 text-sm">
            <dt class="text-ink-muted">Status</dt>
            <dd class="text-ink">{subscription.status}</dd>
            <dt class="text-ink-muted">Renews</dt>
            <dd class="text-ink">
              {subscription.cancelAtPeriodEnd ? "Cancels" : "Renews"} {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
            </dd>
            <dt class="text-ink-muted">Config reads left</dt>
            <dd class="text-ink">{meter ? describeMeter(meter) : "—"}</dd>
          </dl>
        ) : null}
        <div class="mt-4 flex flex-wrap gap-2">
          {pro ? (
            <a href="/api/polar/portal">
              <Button>Manage billing</Button>
            </a>
          ) : (
            <a href="/api/polar/checkout">
              <Button>Upgrade to Pro</Button>
            </a>
          )}
          <Button variant="secondary" disabled={busy} onClick={() => void sync()}>
            Refresh from Polar
          </Button>
          {pro ? (
            <Button variant="secondary" disabled={busy} onClick={() => void useApi()}>
              Use 5M config reads
            </Button>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

function describeMeter(meter: { balance: number; creditedUnits: number }): string {
  const millions = (units: number) => `${(units / 1_000_000).toLocaleString()}M`;
  if (meter.balance < 0) return `${millions(-meter.balance)} over the ${millions(meter.creditedUnits)} included (billed as overage)`;
  return `${millions(meter.balance)} of ${millions(meter.creditedUnits)}`;
}
