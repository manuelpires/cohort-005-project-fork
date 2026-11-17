import { useState } from "react";
import { useFetcher } from "react-router";
import { MessageSquare, NotebookPen } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Textarea } from "~/components/ui/textarea";
import { DiscussionBody, DiscussionSection } from "~/components/comment-thread";
import { cn, formatRelativeTime } from "~/lib/utils";
import { MAX_NOTE_LENGTH } from "~/modules/notes";
import type { RenderedComment } from "~/modules/lesson-viewer/index.server";

export type SavedNote = { body: string; updatedAt: string };

type PanelProps = {
  note: SavedNote | null;
  currentUserId: number | null;
  comments: RenderedComment[];
  canModerate: boolean;
  canPost: boolean;
  instructorName: string;
};

/**
 * The Lesson's Notes and its Discussion in one panel at the foot of the
 * page, so a Student's Notes sit beside the Discussion they may otherwise
 * never open. A Person without notes lands on the Discussion; the Notes tab
 * waits one click away. Without a Person there is nothing to keep private,
 * so only the Discussion shows.
 *
 * Remounts per lesson (the route keys it by lesson id), which resets the
 * unsaved draft when the Student moves on.
 */
export function LessonNotesPanel(props: PanelProps) {
  const { currentUserId } = props;
  // The unsaved draft lives here, above the tab switch, so the dot on the
  // tab and the editor show the same thing.
  const [draft, setDraft] = useState(props.note?.body ?? "");

  if (currentUserId === null) {
    return (
      <DiscussionSection
        comments={props.comments}
        currentUserId={currentUserId}
        canModerate={props.canModerate}
        canPost={props.canPost}
        instructorName={props.instructorName}
      />
    );
  }

  return (
    <Card className="mb-8">
      <CardContent className="p-6">
        <NotesAndDiscussionTabs
          {...props}
          draft={draft}
          onDraftChange={setDraft}
        />
      </CardContent>
    </Card>
  );
}

/**
 * Every comment in the thread, replies included — the number the Discussion
 * tab shows. comments.length only counts questions.
 */
function countComments(comments: RenderedComment[]): number {
  return comments.reduce(
    (total, comment) => total + 1 + countComments(comment.replies),
    0
  );
}

function NotesAndDiscussionTabs({
  note,
  comments,
  canModerate,
  canPost,
  instructorName,
  currentUserId,
  draft,
  onDraftChange,
}: PanelProps & {
  draft: string;
  onDraftChange: (draft: string) => void;
}) {
  const hasUnsavedChanges = draft.trim() !== (note?.body ?? "").trim();

  return (
    <Tabs defaultValue={note ? "notes" : "discussion"}>
      <PanelTabs
        hasUnsavedChanges={hasUnsavedChanges}
        commentCount={countComments(comments)}
      />

      <TabsContent value="notes" className="mt-4">
        <NoteEditor note={note} draft={draft} onDraftChange={onDraftChange} />
      </TabsContent>

      <TabsContent value="discussion" className="mt-4">
        <DiscussionBody
          comments={comments}
          currentUserId={currentUserId}
          canModerate={canModerate}
          canPost={canPost}
          instructorName={instructorName}
        />
      </TabsContent>
    </Tabs>
  );
}

function PanelTabs({
  hasUnsavedChanges,
  commentCount,
}: {
  hasUnsavedChanges: boolean;
  commentCount: number;
}) {
  return (
    <TabsList>
      <TabsTrigger value="notes">
        <NotebookPen className="size-4" />
        Your notes
        {hasUnsavedChanges && (
          <>
            <span aria-hidden className="size-1.5 rounded-full bg-primary" />
            <span className="sr-only">(unsaved changes)</span>
          </>
        )}
      </TabsTrigger>
      <TabsTrigger value="discussion">
        <MessageSquare className="size-4" />
        Discussion
        {commentCount > 0 && (
          <span className="rounded-full bg-primary/10 px-1.5 text-xs font-medium text-primary">
            {commentCount}
          </span>
        )}
      </TabsTrigger>
    </TabsList>
  );
}

function NoteEditor({
  note,
  draft,
  onDraftChange,
}: {
  note: SavedNote | null;
  draft: string;
  onDraftChange: (draft: string) => void;
}) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const isSaving = fetcher.state !== "idle";
  const error = fetcher.data?.error;
  // The server validates the trimmed body, so the Save gate trims too — a
  // draft over the limit only in its trailing whitespace still saves.
  const tooLong = draft.trim().length > MAX_NOTE_LENGTH;
  const empty = draft.trim().length === 0;

  return (
    <fetcher.Form method="post" className="space-y-3">
      <input type="hidden" name="intent" value="save-note" />
      <Textarea
        name="body"
        rows={7}
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        placeholder="Jot down what you want to remember from this lesson — timestamps, snippets, questions. Only you can read this."
        aria-label="Your notes"
      />
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={isSaving || empty || tooLong}>
          {isSaving ? "Saving..." : "Save note"}
        </Button>
        {error && <span className="text-sm text-red-600">{error}</span>}
        {!error && note && (
          <span
            suppressHydrationWarning
            className="text-xs text-muted-foreground"
          >
            Last edited {formatRelativeTime(note.updatedAt)}
          </span>
        )}
        <span
          className={cn(
            "ml-auto text-xs",
            tooLong ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {draft.length} / {MAX_NOTE_LENGTH.toLocaleString("en")}
        </span>
      </div>
    </fetcher.Form>
  );
}
