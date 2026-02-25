/**
 * tRPC page-context router — stores and retrieves per-user page context.
 *
 * Page context is ephemeral session state: the current route and a prompt
 * string that the LLM uses for page-aware responses. When WOP-1020 lands,
 * this migrates from the in-memory Map to the session store.
 */

import { z } from "zod";
import { protectedProcedure, router } from "../init.js";

// ---------------------------------------------------------------------------
// In-memory page context store (keyed by user ID)
// ---------------------------------------------------------------------------

export interface PageContext {
  currentPage: string;
  pagePrompt: string | null;
}

const store = new Map<string, PageContext>();

/** Update page context for a user. Exported for testing. */
export function updatePageContext(userId: string, ctx: PageContext): void {
  store.set(userId, ctx);
}

/** Get page context for a user. Used by context providers before LLM calls. */
export function getPageContext(userId: string): PageContext | null {
  return store.get(userId) ?? null;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const updatePageContextSchema = z.object({
  currentPage: z.string().min(1).max(500),
  pagePrompt: z.string().max(2000).nullable(),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const pageContextRouter = router({
  /** Update the page context for the current user. Called on route change. */
  update: protectedProcedure.input(updatePageContextSchema).mutation(({ ctx, input }) => {
    updatePageContext(ctx.user.id, {
      currentPage: input.currentPage,
      pagePrompt: input.pagePrompt,
    });
    return { ok: true as const };
  }),

  /** Get the current page context for the authenticated user. */
  current: protectedProcedure.query(({ ctx }) => {
    return getPageContext(ctx.user.id);
  }),
});
