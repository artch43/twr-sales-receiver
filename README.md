# TWR Sales Receiver

API em TypeScript que recebe webhooks de vendas de plataformas de checkout (`POST`) e devolve um relatório das vendas (`GET`). Feita para o Desafio TWR: Receptor de Postbacks.

- **URL pública:** https://twr-sales-receiver.onrender.com/
- **Tecnologias:** Node.js, TypeScript, Express, SQLite (`better-sqlite3`), Zod, Vitest e Supertest

## Como chamar

**POST** (registrar uma venda). O header `x-webhook-token` é obrigatório. Token de demonstração: `<5ac08e5820fe4f7181baff9bd91fd29d>`

```bash
curl -i -X POST https://twr-sales-receiver.onrender.com/webhooks/sales \
  -H "Content-Type: application/json" \
  -H "x-webhook-token: <TOKEN_DE_DEMONSTRAÇÃO>" \
  -d '{
    "eventId": "evt_001",
    "orderId": "ord_123",
    "customerEmail": "cliente@email.com",
    "amount": 199.90,
    "currency": "BRL",
    "status": "paid",
    "occurredAt": "2026-10-23T13:00:00.000Z"
  }'
```

**GET** (relatório):

```bash
curl https://twr-sales-receiver.onrender.com/reports/sales
curl "https://twr-sales-receiver.onrender.com/reports/sales?limit=5"
```

Exemplo de resposta do GET:

```json
{
  "totalSales": 1,
  "totalRevenue": 199.9,
  "currency": "BRL",
  "returnedSales": 1,
  "sales": [
    { "eventId": "evt_001", "orderId": "ord_123", "amount": 199.9, "currency": "BRL", "status": "paid", "occurredAt": "2026-10-23T13:00:00.000Z" }
  ]
}
```

`totalSales` e `totalRevenue` somam todas as vendas. A lista `sales` vem da mais recente para a mais antiga e é limitada por `limit` (padrão 100, máximo 1000).

> O serviço está num plano gratuito: se ficar parado um tempo, a primeira requisição pode demorar alguns segundos.

## Rotas e respostas

- `GET /`: confirma que a API está no ar.
- `POST /webhooks/sales`: registra uma venda.
- `GET /reports/sales`: relatório de vendas.

| Status | Quando acontece (POST) |
|---|---|
| `201` | venda nova registrada |
| `200` | evento já recebido antes (`duplicate: true`), nada muda |
| `202` | evento válido, mas com `status` diferente de `paid` (ex.: reembolso), ignorado |
| `400` | JSON malformado ou dados inválidos (a resposta diz quais campos) |
| `401` | token ausente ou errado |
| `413` | corpo maior que 100 KB |
| `500` | erro interno (mensagem genérica) |

## Formato do webhook

| Campo | Regra |
|---|---|
| `eventId` | texto de 1 a 100 caracteres; identifica o evento |
| `orderId` | texto de 1 a 100 caracteres |
| `customerEmail` | e-mail válido |
| `amount` | em reais, maior que 0, até 1.000.000, no máximo 2 casas decimais |
| `currency` | somente `"BRL"` |
| `status` | texto; só `"paid"` entra no relatório |
| `occurredAt` | data ISO 8601 (com `Z` ou fuso, como `-03:00`) |

Campos extras enviados pela plataforma são ignorados.

## O que eu fiz (e por quê)

Pensei no que acontece quando plataformas reais mandam notificações e tratei estes casos:

- **Venda repetida.** Plataformas reenviam o mesmo aviso quando há falha de rede ou demora. Por isso o `eventId` é chave primária no SQLite e a gravação usa `INSERT OR IGNORE`. Checar e gravar acontecem numa única operação do banco, então um reenvio (mesmo simultâneo) não conta a venda duas vezes. O reenvio responde `200` (e não erro) para a plataforma entender que deu certo e parar de tentar. Se o reenvio vier com valores diferentes, a venda original não muda.
- **Dados inválidos.** Valido tudo na entrada com Zod. Se algo estiver errado, respondo `400` listando os campos com problema e não gravo nada. O banco ainda tem `CHECK` como segunda proteção.
- **Campos novos.** Não rejeito campos extras, porque plataformas costumam adicionar campos ao payload e rejeitar faria o webhook falhar e ser reenviado sem parar.
- **Dinheiro.** Guardo em centavos (inteiros) para evitar erro de ponto flutuante (0,1 + 0,2 não dá 0,3 no computador). Aceito só valores positivos, com até 2 casas decimais e no máximo R$ 1.000.000 por venda (limite que escolhi para barrar números absurdos).
- **Datas.** Só aceito ISO 8601 e converto tudo para UTC antes de gravar. Assim o relatório ordena certo mesmo quando chegam fusos diferentes.
- **Eventos que não são `paid`.** Um reembolso é um evento válido, mas não é venda. Respondo `202` e ignoro, em vez de `400`, para a plataforma não ficar reenviando.
- **Segurança.** O `POST` exige um token no header `x-webhook-token`; sem ele, qualquer pessoa que achasse a URL poderia forjar vendas. O token é conferido antes de ler o corpo, a comparação é em tempo constante, ele vem de variável de ambiente (nunca vai para o código) e o servidor nem inicia sem ele. Também limito o corpo a 100 KB e uso erro `500` genérico, sem expor detalhes internos.
- **Relatório.** Não mostra o e-mail do cliente (é dado pessoal numa rota aberta) e tem `limit` para não devolver o banco inteiro.
- **Testes.** São 17 testes automatizados (Vitest + Supertest, banco em memória): venda válida, duplicada, valor inválido, campo ausente, JSON malformado, token, campos extras, status não `paid`, datas, limite de valor, privacidade do relatório, `limit`, corpo grande e persistência depois de fechar e reabrir o banco.
- **Organização.** O código é separado em `db.ts` (banco), `app.ts` (rotas e validação) e `server.ts` (inicia o servidor), o que facilita testar. O servidor também fecha o banco ao receber `SIGINT`/`SIGTERM`.

## O que eu decidi não fazer (e por quê)

| Reembolsos, cancelamentos e ciclo de vida do pedido | O enunciado não define essas regras; hoje cada evento `paid` é independente | Ligar os eventos pelo `orderId` e tratar estornos |
| Eventos fora de ordem | Depende do item acima | Guardar o histórico de eventos e recalcular o estado do pedido |
Proteger o GET /reports/sales. Deixei aberto para facilitar a avaliação. Em produção ele exigiria autenticação.
| Limite de requisições (rate limit) | Fora do escopo do tempo estimado | Limitar por IP/token |
| Paginação por cursor, filtro por período, várias moedas | O `limit` já evita respostas gigantes | Evoluir o relatório |
| Fila / processamento assíncrono | A gravação é rápida e síncrona | Usar fila se o volume crescer |
| Teste de carga e de concorrência | Confio na atomicidade do banco, mas não medi | Testar com várias requisições simultâneas |
| Banco persistente no deploy, migrações e CI | Prazo e plano gratuito | Disco persistente ou Postgres, migrações e testes automáticos no GitHub |

## Limitação do deploy

O deploy está no plano gratuito da Render, que usa disco temporário: o arquivo SQLite pode ser apagado quando o serviço reinicia, é atualizado ou fica ocioso. Localmente os dados persistem (tem teste para isso). Em produção eu usaria disco persistente ou um Postgres gerenciado.

## Rodando localmente

```bash
npm install
cp .env.example .env
npm run dev
npm test
npm run build
```

Variáveis: `WEBHOOK_TOKEN` (obrigatória), `DB_PATH` (padrão `./data/sales.sqlite`) e `PORT` (padrão 3000).