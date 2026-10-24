import { createDatabase } from "./db";
import { createApp } from "./app";

// Segredo compartilhado com a plataforma. Sem ele o servidor se recusa a subir
// (melhor falhar na partida do que rodar aberto para qualquer um).
const webhookToken = process.env.WEBHOOK_TOKEN;

if (!webhookToken) {
  console.error("Defina a variável de ambiente WEBHOOK_TOKEN antes de iniciar.");
  process.exit(1);
}

const dbPath = process.env.DB_PATH ?? "./data/sales.sqlite";

const db = createDatabase(dbPath);
const app = createApp(db, { webhookToken });

const PORT = Number(process.env.PORT ?? 3000);

const server = app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Banco de dados: ${dbPath}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);