'use client';

import { forgetLongTermMemoryAction } from '@/app/profile/actions';
import {
  btn,
  cardBodyClass,
  cardFooterClass,
  cardHeaderClass,
  cardShellClass,
  cardTitleClass,
} from '@/lib/ui';
import { ConfirmButton } from '@/lib/ui-client';

/** Owner controls for the data that actually enters recall and voice rewriting. */
export function PrivacyControls() {
  return (
    <section className={`${cardShellClass} mt-6`}>
      <div className={cardBodyClass}>
        <div className={cardHeaderClass}>
          <div>
            <h2 className={cardTitleClass}>Export or erase saved memory</h2>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">
              Download the saved facts, knowledge-graph projections, people profiles, and writing
              voice that shape recall. The export never includes credentials or embeddings.
            </p>
          </div>
        </div>
      </div>
      <footer className={`${cardFooterClass} flex-wrap`}>
        <a href="/api/profile-export" className={btn.outline}>
          Download memory export
        </a>
        <form action={forgetLongTermMemoryAction}>
          <ConfirmButton
            confirmLabel="Erase memory & voice"
            pendingLabel="Erasing…"
            title="Permanently delete saved facts, graph projections, voice samples, and the learned voice profile"
          >
            Forget long-term memory
          </ConfirmButton>
        </form>
      </footer>
      <p className="px-4 pb-4 text-xs leading-5 text-muted sm:px-6 sm:pb-6">
        Erasure preserves only anonymous content hashes to prevent forgotten facts from being
        re-ingested. Chats, goals, people records, and connected accounts are left intact.
      </p>
    </section>
  );
}
