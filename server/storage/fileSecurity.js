// File Security Provider abstraction (spec §24). No scanner is configured
// or implemented in this pass — this exists so the upload pipeline has a
// single place to call, and so a future ClamAV or cloud-scanning adapter
// slots in without touching fileService.js. The one rule that matters: this
// must NEVER report a file as "clean" unless a real scanner actually ran.
// Every file today gets 'not_scanned', which is the honest state.

export function securityStatus() {
  const provider = process.env.MALWARE_SCAN_PROVIDER || null;
  return {
    configured: false, // flip to true only once a real adapter (e.g. ClamAV) is implemented and wired in below
    provider,
    reason: provider
      ? `MALWARE_SCAN_PROVIDER is set to "${provider}" but no adapter for it is implemented yet.`
      : "No malware scanning provider is configured. Files are stored and processed without a virus/malware scan.",
  };
}

// scanFile({ filePath }) -> { status: 'not_scanned'|'clean'|'infected'|'scan_failed', provider: string|null }
// Always returns 'not_scanned' until a real provider (ClamAV, a cloud
// scanning API, etc.) is implemented here. Kept async since every real
// implementation will need to be.
export async function scanFile() {
  return { status: "not_scanned", provider: null };
}
