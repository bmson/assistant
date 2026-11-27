'use client';

import type {
  ActiveSavedPlace,
  SavedPlaceDetails,
  SavedPlacesSnapshot,
  SavedPlaceWrite,
} from '@assistant/persistence';
import { type FormEvent, useEffect, useRef, useState, useTransition } from 'react';
import { btn, Card, SectionHeading } from '@/lib/ui';
import { savePlace } from './saved-places-action';

const categories = {
  school: 'School',
  work: 'Work',
  venue: 'Regular venue',
} as const;

const fieldClass = 'rounded-lg border border-edge bg-surface px-3 py-2';

type Editor = { place?: ActiveSavedPlace; details: SavedPlaceDetails };
type Review = { command: SavedPlaceWrite; details: SavedPlaceDetails };

export function SavedPlacesPanel({ initial }: { initial?: SavedPlacesSnapshot }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [editor, setEditor] = useState<Editor>();
  const [review, setReview] = useState<Review>();
  const [feedback, setFeedback] = useState<{ text: string; error: boolean }>();
  const [pending, startTransition] = useTransition();
  const step = review ? 'review' : editor ? 'editor' : 'list';
  const stepHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (step !== 'list') stepHeading.current?.focus();
  }, [step]);

  function edit(place?: ActiveSavedPlace) {
    setFeedback(undefined);
    setEditor({ place, details: place?.details ?? { category: 'school', label: '', address: '' } });
  }

  function prepare(details: SavedPlaceDetails | null, place?: ActiveSavedPlace) {
    if (!snapshot) return;
    const displayed = details ?? place?.details;
    if (!displayed) return;
    setFeedback(undefined);
    setReview({
      details: displayed,
      command: {
        id: place?.id ?? crypto.randomUUID(),
        expectedRevision: place?.revision ?? null,
        revision: crypto.randomUUID(),
        details,
        generation: snapshot.generation,
      },
    });
  }

  function reviewEdit(event: FormEvent) {
    event.preventDefault();
    if (!editor) return;
    const { category, label, address } = editor.details;
    const details = { category, label: label.trim(), address: address.trim() };
    if (!details.label || !details.address) {
      setFeedback({ text: 'Enter a name and full address.', error: true });
      return;
    }
    prepare(details, editor.place);
  }

  function confirm() {
    if (!review) return;
    startTransition(async () => {
      try {
        const result = await savePlace(review.command);
        if ('error' in result) {
          setFeedback({ text: result.error, error: true });
          return;
        }
        setSnapshot(result.snapshot);
        setEditor(undefined);
        setReview(undefined);
        setFeedback({
          text: review.command.details ? 'Place saved.' : 'Place removed.',
          error: false,
        });
      } catch {
        setFeedback({
          text: 'The change could not be confirmed. Reopen Settings to check your saved places.',
          error: true,
        });
      }
    });
  }

  return (
    <section className="grid gap-4 border-t border-edge/70 pt-8">
      <SectionHeading title="Saved places" />
      {snapshot === undefined ? (
        <p role="alert" className="text-sm text-muted">
          Saved places couldn’t be loaded. Reopen Settings to try again.
        </p>
      ) : (
        <>
          {snapshot.places.length === 0 ? (
            <p className="text-sm text-muted">No saved places yet.</p>
          ) : (
            <ul className="grid gap-2">
              {[...snapshot.places]
                .sort(
                  (a, b) =>
                    a.details.label.localeCompare(b.details.label) ||
                    a.details.address.localeCompare(b.details.address),
                )
                .map((place) => (
                  <li key={place.id}>
                    <Card className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0 break-words">
                        <h3 className="font-medium">{place.details.label}</h3>
                        <p className="text-sm text-muted">
                          {categories[place.details.category]} · {place.details.address}
                        </p>
                      </div>
                      {!editor && !review ? (
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className={btn.outline}
                            aria-label={`Edit ${place.details.label}, ${place.details.address}`}
                            onClick={() => edit(place)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className={btn.outline}
                            aria-label={`Remove ${place.details.label}, ${place.details.address}`}
                            onClick={() => prepare(null, place)}
                          >
                            Remove
                          </button>
                        </div>
                      ) : null}
                    </Card>
                  </li>
                ))}
            </ul>
          )}
          {review ? (
            <Card className="grid gap-3" aria-busy={pending}>
              <h3 className="font-medium" tabIndex={-1} ref={stepHeading}>
                {review.command.details ? 'Confirm saved place' : 'Remove this place?'}
              </h3>
              <p>
                {review.details.label} · {categories[review.details.category]}
              </p>
              <p className="break-words text-sm text-muted">{review.details.address}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={btn.outline} disabled={pending} onClick={confirm}>
                  {review.command.details ? 'Save place' : 'Remove place'}
                </button>
                <button
                  type="button"
                  className={btn.outline}
                  disabled={pending}
                  onClick={() => {
                    setReview(undefined);
                    setFeedback(undefined);
                  }}
                >
                  {editor ? 'Back to edit' : 'Cancel'}
                </button>
              </div>
            </Card>
          ) : editor ? (
            <Card>
              <form className="grid gap-3" onSubmit={reviewEdit}>
                <h3 className="font-medium" tabIndex={-1} ref={stepHeading}>
                  {editor.place ? 'Edit saved place' : 'Add a saved place'}
                </h3>
                <label className="grid gap-1 text-sm font-medium">
                  Category
                  <select
                    className={fieldClass}
                    value={editor.details.category}
                    onChange={(event) => {
                      const category = event.target.value as SavedPlaceDetails['category'];
                      setEditor({ ...editor, details: { ...editor.details, category } });
                    }}
                  >
                    <option value="school">School</option>
                    <option value="work">Work</option>
                    <option value="venue">Regular venue</option>
                  </select>
                </label>
                <label className="grid gap-1 text-sm font-medium">
                  Place name
                  <input
                    className={fieldClass}
                    required
                    maxLength={80}
                    value={editor.details.label}
                    onChange={(event) =>
                      setEditor({
                        ...editor,
                        details: { ...editor.details, label: event.target.value },
                      })
                    }
                  />
                </label>
                <label className="grid gap-1 text-sm font-medium">
                  Full address
                  <input
                    className={fieldClass}
                    required
                    maxLength={300}
                    autoComplete="off"
                    aria-describedby="saved-place-address-help"
                    value={editor.details.address}
                    onChange={(event) =>
                      setEditor({
                        ...editor,
                        details: { ...editor.details, address: event.target.value },
                      })
                    }
                  />
                </label>
                <p id="saved-place-address-help" className="text-sm text-muted">
                  Include the city, region, postal code and country where applicable. Add the unit
                  or entrance if it distinguishes this place.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button type="submit" className={btn.outline}>
                    Review place
                  </button>
                  <button
                    type="button"
                    className={btn.outline}
                    onClick={() => {
                      setEditor(undefined);
                      setFeedback(undefined);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </Card>
          ) : (
            <div>
              <button type="button" className={btn.outline} onClick={() => edit()}>
                Add place
              </button>
            </div>
          )}
          {feedback ? (
            <p role={feedback.error ? 'alert' : 'status'} className="text-sm">
              {feedback.text}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
