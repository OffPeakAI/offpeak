const TERMS: [string, string][] = [
  ["Beta, as is", "Offpeak is in beta. It is provided as is, with no warranty. Smart contracts can fail, and you could lose your balance."],
  ["Prepaid credit", "Your balance is prepaid credit for Offpeak. It is not a bank deposit and not e-money. It cannot be transferred to anyone else, and it earns no interest or other income."],
  ["Withdrawing", "You can withdraw at any time. The reserved part of a balance can take up to 2 hours. A withdraw-all request completes inside that window."],
  ["Third parties", "USDG can be frozen by its issuer, and Offpeak cannot undo that. Permit2 is a shared dependency."],
  ["Tax", "You are responsible for your own tax."],
  ["Your keys", "Offpeak is not a fiduciary and does not hold your keys. Your wallet signs every transaction, and a lost key cannot be recovered."],
]

export function Terms() {
  return (
    <>
      <header className="page-head">
        <h1>Terms</h1>
        <p className="lede">The short version of what you accept when you use Offpeak. Last updated 2 November 2026.</p>
      </header>
      <ol className="limits">
        {TERMS.map(([title, text]) => (
          <li key={title}>
            <strong>{title}.</strong> {text}
          </li>
        ))}
      </ol>
      <p className="note">
        These sit alongside the <a href="/docs#limits">honest limits</a>.
      </p>
    </>
  )
}
