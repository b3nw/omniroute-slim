import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

// English-only docs. There is no locale to resolve here any more and no
// translated-markdown branch to pick: `config/i18n.json` ships a single locale
// (`DEFAULT_LOCALE`), the root layout already sets `<html lang>` from it, and
// the `docs/i18n/<locale>/` tree this route used to fall back into is gone.
//
// What used to live here: a `getDocsLocale()` that read `NEXT_LOCALE` through a
// *synchronous* `cookies()` call. `cookies()` returns a Promise in Next 15, so
// `.get()` on it never resolved a cookie — the surrounding try/catch swallowed
// the failure and the function returned `DEFAULT_LOCALE` by accident on every
// request, while still opting the route into dynamic rendering.

// ── Page component ──────────────────────────────────────────────────────────

export default async function Page(props: { params: Promise<{ slug: string[] }> }) {
  const params = await props.params;
  const { source } = await import("../../../lib/source");
  const [{ DocsPage, DocsBody }, defaultMdxComponents] = await Promise.all([
    import("fumadocs-ui/layouts/docs/page"),
    import("fumadocs-ui/mdx"),
  ]);
  const page = source.getPage(params.slug);
  if (!page) notFound();

  // English MDX rendered natively by Fumadocs.
  const MDX = page.data.body;
  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsBody>
        <MDX components={{ ...defaultMdxComponents }} />
      </DocsBody>
    </DocsPage>
  );
}

// ── Runtime metadata ───────────────────────────────────────────────────────

// Keep the docs route dynamic. Fumadocs' generated source includes build-only
// metadata that Next's Bun page-data workers cannot reliably traverse during
// generateStaticParams; rendering on request preserves the docs while keeping
// the production build Bun-compatible.
export const dynamic = "force-dynamic";

export async function generateMetadata(props: {
  params: Promise<{ slug: string[] }>;
}): Promise<Metadata> {
  const params = await props.params;
  const { source } = await import("../../../lib/source");
  const page = source.getPage(params.slug);
  if (!page) return {};
  const t = await getTranslations("docs");

  return {
    title: t("pageMetadataTitle", { title: page.data.title }),
    description: page.data.description ?? t("pageMetadataDescription", { title: page.data.title }),
  };
}
