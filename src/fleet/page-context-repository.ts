import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { pageContexts } from "../db/schema/index.js";

export interface PageContext {
  userId: string;
  currentPage: string;
  pagePrompt: string | null;
  updatedAt: number;
}

export interface IPageContextRepository {
  get(userId: string): Promise<PageContext | null>;
  set(userId: string, currentPage: string, pagePrompt: string | null): Promise<void>;
  list(): Promise<PageContext[]>;
}

export class DrizzlePageContextRepository implements IPageContextRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(userId: string): Promise<PageContext | null> {
    const rows = await this.db.select().from(pageContexts).where(eq(pageContexts.userId, userId));
    return rows[0] ? this.toPageContext(rows[0]) : null;
  }

  async set(userId: string, currentPage: string, pagePrompt: string | null): Promise<void> {
    await this.db
      .insert(pageContexts)
      .values({ userId, currentPage, pagePrompt, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: pageContexts.userId,
        set: { currentPage, pagePrompt, updatedAt: Date.now() },
      });
  }

  async list(): Promise<PageContext[]> {
    const rows = await this.db.select().from(pageContexts);
    return rows.map((r: typeof pageContexts.$inferSelect) => this.toPageContext(r));
  }

  private toPageContext(row: typeof pageContexts.$inferSelect): PageContext {
    return {
      userId: row.userId,
      currentPage: row.currentPage,
      pagePrompt: row.pagePrompt,
      updatedAt: row.updatedAt,
    };
  }
}
