"use client";

import { useAuth, useMutation, useQuery } from "@spacefast/zero/client";
import { Alert, Badge, Button, Card, EmptyState, Input } from "@spacefast/zero/kit";
import { useState } from "preact/hooks";
import { cleanNote, type Entitlements, FREE_NOTE_LIMIT, isPro, type Note } from "../shared/plans";

export default function NotesPage() {
  const auth = useAuth();
  const notes = useQuery<Note[]>("notes") ?? [];
  const entitlements = useQuery<Entitlements>("entitlements");
  const addNote = useMutation<[body: string], { ok: boolean; reason?: string }>("addNote");
  const deleteNote = useMutation<[id: string], void>("deleteNote");
  const [error, setError] = useState<string | null>(null);
  const pro = isPro(entitlements);

  if (!auth.isLoading && !auth.isSignedIn) {
    return (
      <Card title="Polar integration test" subtitle="Sign in to keep notes. Free accounts get three; Pro is unlimited.">
        <EmptyState title="Signed out" description="Sign in with Spacefast above." />
      </Card>
    );
  }

  async function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const body = cleanNote(String(new FormData(form).get("body") ?? ""));
    if (!body) return;
    const result = await addNote(body);
    if (result.ok) {
      setError(null);
      form.reset();
    } else if (result.reason === "limit") {
      setError(`Free accounts keep ${FREE_NOTE_LIMIT} notes. Upgrade to Pro on the Billing page for unlimited notes.`);
    }
  }

  return (
    <Card
      title="Notes"
      subtitle="Stored in the space database. The free-plan limit is enforced on the server from Polar entitlements."
      footer={
        pro ? (
          <Badge tone="success">Pro · unlimited</Badge>
        ) : (
          <Badge tone="accent">
            {notes.length} / {FREE_NOTE_LIMIT} free notes
          </Badge>
        )
      }
    >
      <form class="flex gap-2" onSubmit={(event) => void onSubmit(event)}>
        <Input name="body" placeholder="Write a note" aria-label="New note" />
        <Button type="submit">Add</Button>
      </form>
      {error ? (
        <div class="mt-3">
          <Alert tone="warning">{error}</Alert>
        </div>
      ) : null}
      {notes.length === 0 ? (
        <div class="mt-4">
          <EmptyState title="No notes yet" description="Add the first one above." />
        </div>
      ) : (
        <ul class="mt-4 divide-y divide-line">
          {notes.map((note) => (
            <li key={note.id} class="flex items-center justify-between gap-3 py-2.5">
              <span class="text-sm text-ink">{note.body}</span>
              <Button variant="ghost" size="sm" onClick={() => void deleteNote(note.id)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
