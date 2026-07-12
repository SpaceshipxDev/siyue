import type { Metadata } from "next";

import { requireCommerce } from "@/lib/auth";

import { MatcherLab } from "./_matcher-lab";
import "./matcher-lab.css";

export const metadata: Metadata = {
  title: "Matcher Lab | Yingma",
  description: "Test document matching against distorted real-world captures.",
};

export default async function MatcherLabPage() {
  const user = await requireCommerce();

  return <MatcherLab userName={user.name} />;
}
