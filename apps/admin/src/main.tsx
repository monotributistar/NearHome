import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Refine } from "@refinedev/core";
import simpleRestDataProvider from "@refinedev/simple-rest";
import axios from "axios";
import { authProvider, accessControlProvider } from "./security";
import { App } from "./App";
import "./styles.css";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

const httpClient = axios.create();

httpClient.interceptors.request.use((config) => {
  const token = localStorage.getItem("nearhome_access_token");
  const tenantId = localStorage.getItem("nearhome_active_tenant");

  config.headers = {
    ...(config.headers ?? {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(tenantId ? { "X-Tenant-Id": tenantId } : {})
  } as any;

  return config;
});

httpClient.interceptors.response.use(
  (response) => {
    if (response.data && typeof response.data === "object" && "data" in response.data) {
      response.data = response.data.data;
    }
    return response;
  },
  (error) => {
    if (error?.response?.status === 401) {
      localStorage.removeItem("nearhome_access_token");
      window.location.href = "/login";
    }
    return Promise.reject(error);
  }
);

const dataProvider = simpleRestDataProvider(API_URL, httpClient);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Refine
        dataProvider={dataProvider}
        authProvider={authProvider}
        accessControlProvider={accessControlProvider}
        resources={[
          { name: "tenants" },
          { name: "users" },
          { name: "memberships" },
          { name: "cameras" },
          { name: "plans" },
          { name: "subscriptions" }
        ]}
      >
        <App apiUrl={API_URL} />
      </Refine>
    </BrowserRouter>
  </React.StrictMode>
);
