import { lock } from "@/app/actions/access";
import { demoSignIn } from "@/app/actions/auth";
import { repo } from "@/lib/data";
import { ROLE_LABELS, type Role } from "@/lib/domain/types";

const ORDER: Role[] = ["owner_admin", "office_payroll", "foreman", "employee"];

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const companies = await repo().listCompanies();
  const users = (await Promise.all(companies.map((c) => repo().listUsers(c.id)))).flat();

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-3xl font-bold tracking-tight">Sign in</h1>
      <p className="mt-2 text-sm text-stone-600">
        <strong>Demo mode.</strong> Pick anyone below to see the app as that role. In production, people sign in with a text-message
        code or email link (Supabase Auth), and crews without phones use the site kiosk and a PIN.
      </p>

      {companies.map((c) => (
        <section key={c.id} className="mt-8">
          <div className="mb-3 flex items-center gap-3">
            <span className="h-6 w-6 rounded-md" style={{ background: c.branding.primaryColor }} />
            <div>
              <h2 className="font-bold">{c.branding.appName}</h2>
              <p className="text-xs text-stone-500">{c.name} · {c.timezone} · rules {c.labourRuleSet}</p>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {users
              .filter((u) => u.companyId === c.id)
              .sort((a, b) => ORDER.indexOf(a.role) - ORDER.indexOf(b.role))
              .map((u) => (
                <form key={u.id} action={demoSignIn}>
                  <input type="hidden" name="userId" value={u.id} />
                  {next && <input type="hidden" name="next" value={next} />}
                  <button className="card flex w-full items-center justify-between text-left hover:border-stone-400">
                    <span>
                      <span className="block font-semibold">{u.name}</span>
                      <span className="text-xs text-stone-500">{ROLE_LABELS[u.role]}{u.kioskPin ? ` · kiosk PIN ${u.kioskPin}` : ""}</span>
                    </span>
                    <span className="text-stone-400">→</span>
                  </button>
                </form>
              ))}
          </div>
        </section>
      ))}

      {process.env.ACCESS_EMAIL && (
        <form action={lock} className="mt-10 text-center">
          <button className="text-sm font-semibold text-stone-500 underline">Sign out of the demo environment</button>
        </form>
      )}
    </main>
  );
}
