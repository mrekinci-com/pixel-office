// capture-pane returns the current visible screen, without scrollback. Never
// infer readiness from old output chunks or a placeholder inside a response.
export function terminalScreen(text:string,runner:'codex'|'claude'='codex'){
  if(runner==='claude') {
    const plain=text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\r/g,'');
    const login=/Sign in to Claude|Select login method|Please log in|Login required|Not logged in|Log in to get started/i.test(plain);
    const onboarding=/Choose the text style|Choose.*theme|Do you trust|trust this folder|Quick safety check|Accessing workspace/i.test(plain);
    const main=/Claude Code/.test(plain);
    // A bare prompt only; suggestions, menus, drafts and busy frames are unknown.
    const empty=main && !login && !onboarding && /^\s*❯\s*$/m.test(plain) && !/esc to interrupt|thinking|Working…/i.test(plain);
    return {restricted:false,restrictedSelected:false,restrictedQuitSelected:false,folderAccess:onboarding,empty,main,login,onboarding};
  }
  const plain=text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\r/g,'');
  const folderAccess=/^\s*Folder access(?:\s+\/[^\n]*)?\s*$/mi.test(plain);
  const restricted=folderAccess && /^\s*(?:[›❯>]\s*)?1[.)]\s+Open restricted\s*$/mi.test(plain) && /^\s*(?:[›❯>]\s*)?2[.)]\s+Quit\s*$/mi.test(plain);
  const empty=!folderAccess && /^\s*[›❯>]\s+Ask Codex to do anything\s*$/m.test(plain);
  return {restricted,empty,folderAccess,main:/OpenAI Codex/.test(plain),restrictedSelected:restricted && /^\s*[›❯>]\s*1[.)]\s+Open restricted\s*$/mi.test(plain),restrictedQuitSelected:restricted && /^\s*[›❯>]\s*2[.)]\s+Quit\s*$/mi.test(plain)};
}
