#!/usr/bin/env bash
#
# Enterprise closed-source leak guard (open-core).
#
# This is the PUBLIC repo. Per CLAUDE.md "Enterprise 代码隔离", the closed-source
# enterprise business modules (KB browser/sync, skill/mcp installers, migration
# wizard, kb_query tool, enterprise stores) live ONLY in the private
# Abu-enterprise-modules repo and are swapped in at build time via the
# @enterprise-modules alias. They must NEVER be committed to this tree.
#
# build/test passing does NOT catch this — it's a confidentiality violation, not
# a compile error, and once pushed it cannot be scrubbed from public git history.
# This guard fails CI if any closed-source module file appears in src/.
#
# It is a FILENAME/PATH blacklist (the common leak vector: moving/adding a
# closed-source file). It deliberately excludes names that collide with legit
# OSS files (e.g. src/core/skill/installer.ts is OSS's local-folder installer,
# distinct from the enterprise catalog installer of the same name).
set -euo pipefail

# Paths/names that exist ONLY in the private enterprise overlay.
PATTERNS=(
  'enterprise-kb-query'
  'KbBrowser'
  'PersonalKbView'
  'MigrationWizard'
  'MeTransparencyView'
  'EnterpriseSkillTab'
  'EnterpriseMcpTab'
  'src/core/kb/'
  'src/core/migration/migrator'
  'src/core/migration/scanner'
  'src/core/skill/catalog-sync'
  'src/core/skill/local-store'
  'src/core/skill/verify'
  'src/core/mcp/installer'
  'src/core/mcp/catalog-sync'
  'src/core/mcp/local-store'
  'enterpriseKbStore'
  'enterpriseMcpStore'
  'enterpriseSkillStore'
)

files=$(git ls-files src/)
hits=""
for p in "${PATTERNS[@]}"; do
  m=$(printf '%s\n' "$files" | grep -iF -- "$p" || true)
  [ -n "$m" ] && hits="${hits}${m}"$'\n'
done

if [ -n "$hits" ]; then
  echo "🔴 Enterprise closed-source module(s) found in the public OSS tree:"
  printf '%s' "$hits" | sed 's/^/   /'
  echo ""
  echo "These belong ONLY in the private Abu-enterprise-modules repo."
  echo "See CLAUDE.md → 'Enterprise 代码隔离 — 防泄露红线（open-core）'."
  exit 1
fi

echo "✓ enterprise-leak-guard: no closed-source enterprise modules in OSS tree."
