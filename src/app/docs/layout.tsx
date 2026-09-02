import { RootProvider } from "fumadocs-ui/provider/next";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { source } from "@/lib/source";
import type { ReactNode } from "react";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { getTranslations } from "next-intl/server";

export async function generateMetadata() {
  const t = await getTranslations("docs");
  return {
    title: {
      template: t("metadataTitleTemplate"),
      default: t("metadataDefaultTitle"),
    },
    description: t("metadataDescription"),
    robots: {
      index: true,
      follow: true,
    },
  };
}

export default async function Layout({ children }: { children: ReactNode }) {
  const t = await getTranslations("docs");
  const docsLayoutOptions: BaseLayoutProps = {
    // No locale switcher in the docs nav: the runtime ships a single locale, so
    // the dropdown had exactly one entry to offer.
    nav: {
      title: t("layoutNavTitle"),
      url: "/docs",
    },
    links: [
      {
        text: t("layoutHomeLink"),
        url: "/docs",
      },
      {
        text: t("layoutDashboardLink"),
        url: "/dashboard",
        secondary: true,
      },
    ],
    githubUrl: "https://github.com/diegosouzapw/OmniRoute",
  };

  return (
    <RootProvider
      theme={{
        defaultTheme: "dark",
        attribute: "class",
      }}
      search={{
        options: {
          api: "/docs/api/search",
        },
      }}
    >
      <DocsLayout tree={source.pageTree} {...docsLayoutOptions}>
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
