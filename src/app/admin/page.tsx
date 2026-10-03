import { type Metadata } from "next";
import { AdminDashboard } from "./admin-dashboard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Live · GitDiagram",
  robots: { index: false, follow: false },
};

/** The operator's live dashboard. Only the owner of the operator token gets in. */
export default async function AdminPage() {
  return <AdminDashboard />;
}
