const apiPort = process.env.E2E_API_PORT ?? "3001";
const adminPort = process.env.E2E_ADMIN_PORT ?? "4173";
const portalPort = process.env.E2E_PORTAL_PORT ?? "4174";

export const apiUrl = `http://localhost:${apiPort}`;
export const adminUrl = `http://localhost:${adminPort}`;
export const portalUrl = `http://localhost:${portalPort}`;
