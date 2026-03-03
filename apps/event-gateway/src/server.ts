import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 3011);

const app = await buildApp();

app.listen({ host: "0.0.0.0", port }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
