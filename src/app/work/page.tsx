import { Suspense } from "react";
import WorkConsole from "@/components/WorkConsole";

export default function WorkPage() {
  return <Suspense fallback={<p>Opening your work…</p>}><WorkConsole /></Suspense>;
}
