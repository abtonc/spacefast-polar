"use client";

import { useAuth, useQuery } from "@spacefast/zero/client";
import { Card, CodeBlock, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@spacefast/zero/kit";
import type { Delivery, Entitlements } from "../shared/plans";

export default function DebugPage() {
  const auth = useAuth();
  const entitlements = useQuery<Entitlements>("entitlements");
  const deliveries = useQuery<Delivery[]>("deliveries") ?? [];

  if (!auth.isLoading && !auth.isSignedIn) {
    return (
      <Card title="Debug">
        <EmptyState title="Signed out" description="Sign in with Spacefast to inspect the integration." />
      </Card>
    );
  }

  return (
    <div class="flex flex-col gap-4">
      <Card title="Your user id" subtitle="Sent to Polar as external_customer_id.">
        <code class="text-sm text-ink">{auth.userId}</code>
      </Card>
      <Card title="Stored entitlements" subtitle="The polarEntitlements row for you, live.">
        <CodeBlock code={JSON.stringify(entitlements ?? null, null, 2)} language="json" />
      </Card>
      <Card title="Webhook deliveries" subtitle="Latest Polar webhooks this space accepted.">
        {deliveries.length === 0 ? (
          <EmptyState title="None yet" description="Polar has not delivered a webhook here." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Received</TableHead>
                <TableHead>Webhook id</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveries.map((delivery) => (
                <TableRow key={delivery.id}>
                  <TableCell>{delivery.eventType}</TableCell>
                  <TableCell>{new Date(delivery.createdAt).toLocaleString()}</TableCell>
                  <TableCell class="font-mono text-xs">{delivery.webhookId}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
