// Setzt das Farbschema vor dem ersten Zeichnen (kein Aufblitzen).
// "auto" = wie Windows/Chrome (prefers-color-scheme), sonst "light" | "dark".
try {
  var t = localStorage.getItem('tenantry.theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) {
  /* ohne gespeicherte Einstellung: automatisch */
}
