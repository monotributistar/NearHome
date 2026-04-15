import { Route, Routes } from "react-router-dom";
import { LoginPage } from "./pages/auth/LoginPage.js";
import { RegisterPage } from "./pages/auth/RegisterPage.js";
import { InviteAcceptPage } from "./pages/auth/InviteAcceptPage.js";
import { ProtectedLayout } from "./components/ProtectedLayout.js";

export function PortalApp() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/invite/:token" element={<InviteAcceptPage />} />
      <Route path="/*" element={<ProtectedLayout />} />
    </Routes>
  );
}
