; ---------------------------------------------------------------------------
; MarkdownX NSIS installer hooks (referenced from tauri.conf.json ->
; bundle.windows.nsis.installerHooks).
;
; Tauri's own fileAssociations block already writes, per extension:
;   HKCU\Software\Classes\<ext>            (default) = "<ProgID>"
;   HKCU\Software\Classes\<ProgID>\DefaultIcon
;   HKCU\Software\Classes\<ProgID>\shell\open\command
; and removes them again on uninstall.
;
; Two ProgIDs are in play:
;   "Markdown Document" (Editor) -> .md .markdown .mdown .mkd .mdx
;   "PDF Document"      (Viewer) -> .pdf
; .pdf almost always already has a UserChoice (Edge / Acrobat), so in practice it is
; never hijacked: MarkdownX is merely offered, and the user picks it in
; Settings -> Default apps -> Choose defaults by file type.
;
; These hooks add the two things that block a *clean* automatic association:
;
; 1. OpenWithProgids - makes MarkdownX show up in the "Open with" list through the
;    PROGID, not through a per-executable entry. A per-exe entry (what Windows
;    creates when a user browses to an .exe once) keeps pointing at a path that may
;    later disappear, which is exactly how the picker ends up with several
;    "MarkdownX" rows and blank icons.
;
; 2. Claiming only unclaimed types - Windows 10/11 protects an explicit user choice
;    with UserChoice + Hash; an installer must not fight it. An extension nobody has
;    claimed is fair game, and taking it here is what makes double-click work right
;    after a fresh install. Extensions that already have a UserChoice are left alone:
;    the user picks MarkdownX once in "Open with -> Always".
;
; SHChangeNotify(SHCNE_ASSOCCHANGED) at the end asks Explorer to refresh type icons
; and the picker immediately instead of after the next sign-in.
; ---------------------------------------------------------------------------

!define MDX_PROGID "Markdown Document"
!define MDX_PDF_PROGID "PDF Document"
!define MDX_SHCNE_ASSOCCHANGED 0x08000000

; ${PROGID} = the type this extension offers/claims, ${EXT} = extension without dot.
!macro MDXClaimExt PROGID EXT
  ; Visible in "Open with" via the ProgID (idempotent; the same key on every install).
  WriteRegStr HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}" ""
  ; Claim only when the type is unclaimed: an existing UserChoice belongs to the user.
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.${EXT}\UserChoice" "ProgId"
  StrCmp $0 "" 0 mdx_claimed_${EXT}
    WriteRegStr HKCU "Software\Classes\.${EXT}" "" "${PROGID}"
  mdx_claimed_${EXT}:
!macroend

!macro MDXReleaseExt PROGID EXT
  DeleteRegValue HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
  ; Give back only what we took: if the user never chose anything for this type, our
  ; mapping is removed; an explicit UserChoice is never touched.
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.${EXT}\UserChoice" "ProgId"
  StrCmp $0 "" 0 mdx_free_${EXT}
    DeleteRegValue HKCU "Software\Classes\.${EXT}" ""
  mdx_free_${EXT}:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro MDXClaimExt "${MDX_PROGID}" "md"
  !insertmacro MDXClaimExt "${MDX_PROGID}" "markdown"
  !insertmacro MDXClaimExt "${MDX_PROGID}" "mdown"
  !insertmacro MDXClaimExt "${MDX_PROGID}" "mkd"
  !insertmacro MDXClaimExt "${MDX_PROGID}" "mdx"
  !insertmacro MDXClaimExt "${MDX_PDF_PROGID}" "pdf"
  System::Call 'shell32::SHChangeNotify(i ${MDX_SHCNE_ASSOCCHANGED}, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro MDXReleaseExt "${MDX_PROGID}" "md"
  !insertmacro MDXReleaseExt "${MDX_PROGID}" "markdown"
  !insertmacro MDXReleaseExt "${MDX_PROGID}" "mdown"
  !insertmacro MDXReleaseExt "${MDX_PROGID}" "mkd"
  !insertmacro MDXReleaseExt "${MDX_PROGID}" "mdx"
  !insertmacro MDXReleaseExt "${MDX_PDF_PROGID}" "pdf"
  System::Call 'shell32::SHChangeNotify(i ${MDX_SHCNE_ASSOCCHANGED}, i 0, i 0, i 0)'
!macroend