import { Route, Routes } from "react-router-dom";
import { LoginPage } from "./pages/auth/LoginPage.js";
import { Layout } from "./components/Layout.js";

type AppProps = { apiUrl: string };

export function App({ apiUrl }: AppProps) {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage apiUrl={apiUrl} />} />
      <Route path="/*" element={<Layout apiUrl={apiUrl} />} />
    </Routes>
  );
}
