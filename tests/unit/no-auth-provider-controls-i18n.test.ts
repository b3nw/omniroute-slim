import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Preserved from the retired `i18n-vi-completeness` suite (the Vietnamese
// catalog was removed with the other non-English bundles); this assertion is
// about the component source, not about any particular locale.
test("no-auth provider controls keep locale translators unambiguous", () => {
  const source = readFileSync(
    new URL(
      "../../src/app/(dashboard)/dashboard/providers/[id]/components/NoAuthProviderControls.tsx",
      import.meta.url
    ),
    "utf8"
  );

  assert.equal(source.match(/import \{ useTranslations \} from "next-intl";/g)?.length, 1);
  assert.match(source, /const noAuthT = useTranslations\("noAuthProvider"\);/);
  assert.match(source, /const t = useTranslations\("providers"\);/);
});
