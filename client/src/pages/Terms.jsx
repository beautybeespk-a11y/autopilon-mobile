import LegalLayout, { Section, P } from "../components/LegalLayout.jsx";

// Public, no-login page — registered at /terms in App.jsx, outside the
// /app ProtectedRoute. Same shape as Privacy.jsx/DataDeletion.jsx: the
// Terms of Service URL Meta's App Settings -> Basic requires before an
// app can be submitted for review (previously a placeholder pointing at
// facebook.com).
export default function Terms() {
  return (
    <LegalLayout title="Terms of Service" lastUpdated="October 9, 2026">
      <P>
        These terms govern your use of Autopilon, operated by Moazzam Iqbal, Scheme 33 Karachi, Pakistan. By
        using Autopilon, you agree to them.
      </P>
      <P>
        If you have questions, contact us at <a href="mailto:support@autopilon.com">support@autopilon.com</a>.
      </P>

      <Section heading="What Autopilon is">
        <P>
          Autopilon is a tool that creates and manages Meta (Facebook and Instagram) advertising campaigns on
          your behalf. It connects to your own Meta ad account and your own online store (WooCommerce or
          Shopify) to build campaigns from your real products and business data.
        </P>
        <P>
          Autopilon acts as your agent when you ask it to — it does not own your ad account, your store, or
          any of the assets it works with. Everything it creates belongs to you, in your own accounts.
        </P>
      </Section>

      <Section heading="Your ad spend and approval">
        <P>
          <strong>You are responsible for your own advertising spend.</strong> Autopilon creates campaigns
          paused, and does not activate them or spend any money without your explicit approval. Once you
          approve and activate a campaign, the spend happens in your own Meta ad account, billed by Meta to
          whatever payment method you have on file there — Autopilon does not bill you for ad spend and does
          not hold or move your advertising budget.
        </P>
        <P>
          You can pause, edit, or stop any campaign at any time, directly in Autopilon or in Meta Ads Manager.
        </P>
      </Section>

      <Section heading="Meta's own policies still apply">
        <P>
          Using Autopilon does not change or substitute for your obligations under Meta's own terms —
          including the Meta Advertising Policies, the Meta Platform Terms, and Meta's Terms of Service. You
          are responsible for making sure the campaigns, ads, and products you approve comply with those
          policies. Meta may reject, restrict, or remove ads or disable accounts for policy violations
          regardless of anything in Autopilon, and Autopilon has no control over Meta's enforcement decisions.
        </P>
      </Section>

      <Section heading="Accounts">
        <P>
          Autopilon is currently in private beta. Accounts are created for approved users — today, by an
          administrator, after you request access. We may open self-service sign-up in the future.
        </P>
        <P>
          You can delete your own account at any time, self-service, from <strong>Settings</strong> in the
          app. Deleting your account removes your Autopilon data as described in our Privacy Policy. It does
          not delete campaigns already created in your own Meta ad account — those are yours, and remain
          under your control there.
        </P>
        <P>
          You're responsible for keeping your login credentials secure and for any activity under your
          account.
        </P>
      </Section>

      <Section heading="Your data">
        <P>
          How we collect, use, store, and let you delete your data is covered in full in our{" "}
          <a href="/privacy">Privacy Policy</a> — we don't repeat it here. By using Autopilon, you also agree
          to that policy.
        </P>
      </Section>

      <Section heading="No guarantee of ad performance">
        <P>
          Autopilon is a tool to help you build and manage advertising campaigns — it does not guarantee any
          particular result: not sales, not clicks, not a particular cost per result, not approval by Meta.
          Advertising performance depends on many factors outside our control, including Meta's own ad
          auction, your budget, your products, and market conditions. Autopilon is provided "as is," without
          warranties of any kind, to the fullest extent the law allows.
        </P>
      </Section>

      <Section heading="Limitation of liability">
        <P>
          To the fullest extent permitted by law, Autopilon and Moazzam Iqbal are not liable for any indirect,
          incidental, or consequential damages arising from your use of the service — including lost profits
          or wasted ad spend — beyond the amount you have paid us, if any, in the 12 months before the claim.
          Nothing in these terms limits liability that cannot be limited by law.
        </P>
      </Section>

      <Section heading="Suspending or ending access">
        <P>
          We may suspend or terminate your access if you violate these terms, misuse the service, or if
          required to do so by law or by Meta. You can stop using Autopilon and delete your account at any
          time.
        </P>
      </Section>

      <Section heading="Changes to these terms">
        <P>
          We may update these terms as the product changes. If we make a material change, we'll notify you by
          email or through the service before it takes effect. The date at the top shows when these terms were
          last revised. Continuing to use Autopilon after a change takes effect means you accept the updated
          terms.
        </P>
      </Section>

      <Section heading="Governing law">
        <P>These terms are governed by the laws of Pakistan, without regard to conflict-of-law rules.</P>
      </Section>

      <Section heading="Contact">
        <P>
          Moazzam Iqbal<br />
          Scheme 33 Karachi, Pakistan<br />
          Email: <a href="mailto:support@autopilon.com">support@autopilon.com</a>
        </P>
      </Section>
    </LegalLayout>
  );
}
