import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Sale = {
  eventId: string; // chave primária: cada evento só pode existir uma vez
  orderId: string;
  customerEmail: string;
  amount: number;
  currency: "BRL";
  status: "paid";
  occurredAt: string; // sempre ISO 8601 em UTC (normalizado em app.ts)
};

export type NewSale = Sale;

// Venda como aparece no relatório público: SEM o e-mail do cliente (dado pessoal)
export type ReportSale = Omit<Sale, "customerEmail">;

export function createDatabase(path: string) {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);

  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sales (
      event_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      amount_cents INTEGER NOT NULL
        CHECK (amount_cents > 0),
      currency TEXT NOT NULL
        CHECK (currency = 'BRL'),
      status TEXT NOT NULL
        CHECK (status = 'paid'),
      occurred_at TEXT NOT NULL
    );
  `);

  const insertSale = db.prepare(`
    INSERT OR IGNORE INTO sales (
      event_id,
      order_id,
      customer_email,
      amount_cents,
      currency,
      status,
      occurred_at
    ) VALUES (
      @eventId,
      @orderId,
      @customerEmail,
      @amountCents,
      @currency,
      @status,
      @occurredAt
    )
  `);

  // Mais recentes primeiro, limitado: o relatório não despeja o banco inteiro.
  const listSales = db.prepare(`
    SELECT
      event_id AS eventId,
      order_id AS orderId,
      amount_cents AS amountCents,
      currency,
      status,
      occurred_at AS occurredAt
    FROM sales
    ORDER BY occurred_at DESC, event_id DESC
    LIMIT @limit
  `);

  const countSales = db.prepare(`
    SELECT COUNT(*) AS totalSales
    FROM sales
  `);

  const sumSales = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS totalCents
    FROM sales
  `);

  function registerSale(sale: NewSale) {
    const amountCents = Math.round(sale.amount * 100); // converte para centavos

    const result = insertSale.run({
      eventId: sale.eventId,
      orderId: sale.orderId,
      customerEmail: sale.customerEmail,
      amountCents,
      currency: sale.currency,
      status: sale.status,
      occurredAt: sale.occurredAt
    });

    if (result.changes === 0) {
      return {
        duplicate: true,
        sale: null
      };
    }

    return {
      duplicate: false,
      sale
    };
  }

  function getSalesReport(limit = 100) {
    const rows = listSales.all({ limit }) as Array<{
      eventId: string;
      orderId: string;
      amountCents: number;
      currency: "BRL";
      status: "paid";
      occurredAt: string;
    }>;

    const sales: ReportSale[] = rows.map((row) => ({
      eventId: row.eventId,
      orderId: row.orderId,
      amount: row.amountCents / 100,
      currency: row.currency,
      status: row.status,
      occurredAt: row.occurredAt
    }));

    const { totalSales } = countSales.get() as {
      totalSales: number;
    };

    const { totalCents } = sumSales.get() as {
      totalCents: number;
    };

    return {
      totalSales, // total geral (não depende do limit)
      totalRevenue: totalCents / 100,
      currency: "BRL" as const,
      returnedSales: sales.length, // quantas vendas vieram na lista abaixo
      sales
    };
  }

  return {
    registerSale,
    getSalesReport,
    close: () => db.close()
  };
}

export type SalesDatabase = ReturnType<typeof createDatabase>;