import express from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { SalesDatabase, Sale } from "./db";

// Teto por venda (R$ 1.000.000,00): evita valores absurdos no faturamento.
const MAX_AMOUNT = 1_000_000;

// Sem .strict(): campos extras que a plataforma enviar são ignorados (não geram erro).
const saleSchema = z.object({
  eventId: z.string().trim().min(1).max(100),
  orderId: z.string().trim().min(1).max(100),
  customerEmail: z.string().email(),
  amount: z.number().finite().positive().max(MAX_AMOUNT),
  currency: z.literal("BRL"),
  // O status é validado como texto aqui; só "paid" é contabilizado (ver rota).
  status: z.string().trim().min(1),
  // Data ISO 8601 de verdade (aceita "Z" e fuso como -03:00). "banana 2026" não passa.
  occurredAt: z.string().datetime({ offset: true })
}).superRefine((sale, ctx) => {
  const cents = sale.amount * 100;

  if (Math.abs(cents - Math.round(cents)) > 1e-7) {
    ctx.addIssue({
      code: "custom",
      path: ["amount"],
      message: "O valor deve ter no máximo duas casas decimais"
    });
  }
});

const reportQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100)
});

// Transforma os erros do Zod em algo legível: [{ field, message }]
function formatIssues(error: z.ZodError) {
  return error.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message
  }));
}

// Compara tokens em tempo constante (evita descobrir o segredo medindo tempo de resposta).
// Comparamos os hashes porque timingSafeEqual exige buffers de tamanho igual.
function safeEqual(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

export function createApp(
  db: SalesDatabase,
  options: { webhookToken: string }
) {
  const app = express();

  // Roda ANTES de ler o corpo: sem token válido, nem processamos o JSON.
  const requireToken: express.RequestHandler = (req, res, next) => {
    const received = req.get("x-webhook-token");

    if (!received || !safeEqual(received, options.webhookToken)) {
      res.status(401).json({ error: "Não autorizado." });
      return;
    }

    next();
  };

  app.get("/", (_req, res) => { // rota de teste: o serviço está no ar?
    res.json({
      message: "TWR SALES RECEIVER está funcionando!"
    });
  });

  app.post(
    "/webhooks/sales",
    requireToken,
    express.json({ limit: "100kb" }),
    (req, res) => {
      const result = saleSchema.safeParse(req.body);

      if (!result.success) {
        return res.status(400).json({
          error: "Dados da venda inválidos.",
          details: formatIssues(result.error)
        });
      }

      const data = result.data;

      // Evento válido, mas que não é venda paga (ex.: reembolso): respondemos 2xx
      // para a plataforma não reenviar, e NÃO contabilizamos.
      if (data.status !== "paid") {
        return res.status(202).json({
          message: "Evento recebido, mas ignorado: só vendas pagas (paid) são contabilizadas.",
          ignored: true
        });
      }

      const sale: Sale = {
        eventId: data.eventId,
        orderId: data.orderId,
        customerEmail: data.customerEmail,
        amount: data.amount,
        currency: data.currency,
        status: "paid",
        // normaliza para ISO em UTC: todas as datas ficam no mesmo formato
        occurredAt: new Date(data.occurredAt).toISOString()
      };

      const registration = db.registerSale(sale);

      if (registration.duplicate) {
        return res.status(200).json({
          message: "Evento já processado",
          duplicate: true
        });
      }

      return res.status(201).json({
        message: "Venda registrada com sucesso.",
        sale: registration.sale
      });
    }
  );

  app.get("/reports/sales", (req, res) => {
    const query = reportQuerySchema.safeParse(req.query);

    if (!query.success) {
      return res.status(400).json({
        error: "Parâmetros inválidos.",
        details: formatIssues(query.error)
      });
    }

    return res.json(db.getSalesReport(query.data.limit));
  });

  app.use((
    err: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    if (typeof err === "object" && err !== null && "status" in err) {
      if (err instanceof SyntaxError && err.status === 400) {
        return res.status(400).json({
          error: "JSON inválido."
        });
      }

      if (err.status === 413) {
        return res.status(413).json({
          error: "Corpo da requisição grande demais."
        });
      }
    }

    console.error(err);

    return res.status(500).json({
      error: "Erro interno do servidor."
    });
  });

  return app;
}