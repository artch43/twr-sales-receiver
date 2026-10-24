import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it
} from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db";
import type { Sale, SalesDatabase } from "../src/db";
import { createApp } from "../src/app";

const TOKEN = "token-de-teste";

const validSale: Sale = {
  eventId: "evt_001",
  orderId: "ord_123",
  customerEmail: "cliente@email.com",
  amount: 199.90,
  currency: "BRL",
  status: "paid",
  occurredAt: "2026-10-23T13:00:00.000Z"
};

describe("TWR Sales Receiver", () => {
  let db: SalesDatabase;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createDatabase(":memory:");
    app = createApp(db, { webhookToken: TOKEN });
  });

  afterEach(() => {
    db.close();
  });

  // Atalho: POST já com o token correto
  const postSale = (body: unknown) =>
    request(app)
      .post("/webhooks/sales")
      .set("x-webhook-token", TOKEN)
      .send(body as object);

  const getReport = (query = "") => request(app).get(`/reports/sales${query}`);

  // ---------- comportamentos básicos ----------

  it("registra uma venda válida", async () => {
    const response = await postSale(validSale);

    expect(response.status).toBe(201);
    expect(response.body.sale.eventId).toBe("evt_001");

    const report = await getReport();
    expect(report.body.totalSales).toBe(1);
    expect(report.body.totalRevenue).toBe(199.9);
  });

  it("não registra duas vezes o mesmo evento", async () => {
    const first = await postSale(validSale);
    const second = await postSale(validSale);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    const report = await getReport();
    expect(report.body.totalSales).toBe(1);
    expect(report.body.totalRevenue).toBe(199.9);
  });

  it("rejeita valores negativos", async () => {
    const response = await postSale({ ...validSale, amount: -100 });

    expect(response.status).toBe(400);

    const report = await getReport();
    expect(report.body.totalSales).toBe(0);
  });

  it("rejeita campos obrigatórios ausentes e diz qual campo", async () => {
    const { eventId: _eventId, ...invalidSale } = validSale;
    const response = await postSale(invalidSale);

    expect(response.status).toBe(400);
    expect(response.body.details[0].field).toBe("eventId");
  });

  it("não altera a venda original quando o evento se repete", async () => {
    await postSale(validSale).expect(201);

    const response = await postSale({ ...validSale, amount: 500 });

    expect(response.status).toBe(200);
    expect(response.body.duplicate).toBe(true);

    const report = await getReport();
    expect(report.body.totalSales).toBe(1);
    expect(report.body.totalRevenue).toBe(199.9);
  });

  it("retorna relatório vazio quando não há vendas", async () => {
    const response = await getReport();

    expect(response.status).toBe(200);
    expect(response.body.totalSales).toBe(0);
    expect(response.body.totalRevenue).toBe(0);
    expect(response.body.sales).toEqual([]);
  });

  it("rejeita JSON malformado", async () => {
    const response = await request(app)
      .post("/webhooks/sales")
      .set("x-webhook-token", TOKEN)
      .set("Content-Type", "application/json")
      .send('{"eventId":');

    expect(response.status).toBe(400);
  });

  it("mantém as vendas após fechar e reabrir o banco", () => {
    const directory = mkdtempSync(join(tmpdir(), "twr-sales-"));
    const dbPath = join(directory, "sales.sqlite");

    try {
      const firstDb = createDatabase(dbPath);
      firstDb.registerSale(validSale);
      firstDb.close();

      const secondDb = createDatabase(dbPath);
      try {
        const report = secondDb.getSalesReport();
        expect(report.totalSales).toBe(1);
        expect(report.totalRevenue).toBe(199.9);
        expect(report.sales[0].eventId).toBe("evt_001");
      } finally {
        secondDb.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // ---------- segurança ----------

  it("rejeita requisição sem token ou com token errado (401) e não grava", async () => {
    const semToken = await request(app)
      .post("/webhooks/sales")
      .send(validSale);
    expect(semToken.status).toBe(401);

    const tokenErrado = await request(app)
      .post("/webhooks/sales")
      .set("x-webhook-token", "errado")
      .send(validSale);
    expect(tokenErrado.status).toBe(401);

    const report = await getReport();
    expect(report.body.totalSales).toBe(0);
  });

  it("aceita campos extras enviados pela plataforma (e os ignora)", async () => {
    const response = await postSale({
      ...validSale,
      campoNovo: "qualquer coisa",
      metadata: { origem: "checkout" }
    });

    expect(response.status).toBe(201);
  });

  it("responde 202 a eventos que não são 'paid' e não os contabiliza", async () => {
    const response = await postSale({
      ...validSale,
      eventId: "evt_refund",
      status: "refunded"
    });

    expect(response.status).toBe(202);
    expect(response.body.ignored).toBe(true);

    const report = await getReport();
    expect(report.body.totalSales).toBe(0);
  });

  it("rejeita data inválida", async () => {
    const response = await postSale({
      ...validSale,
      occurredAt: "banana 2026"
    });

    expect(response.status).toBe(400);
  });

  it("normaliza datas com fuso para UTC e ordena corretamente", async () => {
    // 10:00-03:00 equivale a 13:00Z, que é DEPOIS de 12:30Z
    await postSale({
      ...validSale,
      eventId: "evt_fuso",
      occurredAt: "2026-10-23T10:00:00-03:00"
    }).expect(201);
    await postSale({
      ...validSale,
      eventId: "evt_utc",
      occurredAt: "2026-10-23T12:30:00Z"
    }).expect(201);

    const report = await getReport();

    // relatório lista a mais recente primeiro
    expect(report.body.sales[0].eventId).toBe("evt_fuso");
    expect(report.body.sales[0].occurredAt).toBe("2026-10-23T13:00:00.000Z");
  });

  it("rejeita valor acima do teto", async () => {
    const response = await postSale({ ...validSale, amount: 1e20 });

    expect(response.status).toBe(400);
  });

  it("não expõe o e-mail do cliente no relatório", async () => {
    await postSale(validSale).expect(201);

    const report = await getReport();

    expect(report.body.sales[0]).not.toHaveProperty("customerEmail");
    expect(JSON.stringify(report.body)).not.toContain("cliente@email.com");
  });

  it("limita a lista do relatório sem alterar os totais", async () => {
    for (const n of [1, 2, 3]) {
      await postSale({
        ...validSale,
        eventId: `evt_${n}`,
        occurredAt: `2026-10-23T1${n}:00:00Z`
      }).expect(201);
    }

    const report = await getReport("?limit=2");

    expect(report.body.sales).toHaveLength(2);
    expect(report.body.returnedSales).toBe(2);
    expect(report.body.totalSales).toBe(3);

    const invalid = await getReport("?limit=0");
    expect(invalid.status).toBe(400);
  });

  it("rejeita corpo grande demais (413)", async () => {
    const response = await postSale({
      ...validSale,
      padding: "x".repeat(200_000)
    });

    expect(response.status).toBe(413);
  });
});