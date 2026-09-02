import LegalLayout, { Section, P, UL, OL } from "../components/LegalLayout.jsx";

// Public, no-login page — registered at /data-deletion in App.jsx,
// outside the /app ProtectedRoute. This is the "Data Deletion
// Instructions" URL Meta's App Settings -> "User Data Deletion" field
// requires before an app can be published — Meta accepts either a
// callback URL or an instructions page; this is the instructions page.
export default function DataDeletion() {
  return (
    <LegalLayout title="Data Deletion Instructions" lastUpdated="September 2, 2026">
      <P>You can delete your Autopilon data at any time. There are two options.</P>

      <Section heading="Option 1 — Disconnect a single service">
        <P>To remove the data associated with one connected service while keeping your account:</P>
        <OL>
          <li>Sign in at autopilon.com</li>
          <li>Go to <strong>Settings → Integrations</strong></li>
          <li>Find the service — for example Facebook or Instagram — and select <strong>Disconnect</strong></li>
        </OL>
        <P>
          This immediately revokes our access, deletes the stored access token, and deletes the cached data
          we hold from that service. Campaigns already created in your own advertising account are unaffected
          and remain yours to manage.
        </P>
      </Section>

      <Section heading="Option 2 — Delete your entire account">
        <P>To permanently delete your account and everything associated with it, email us — see "Request deletion by email" below.</P>
      </Section>

      <Section heading="Deleting Facebook or Instagram data specifically">
        <P>To remove Autopilon's access from Meta's side:</P>
        <OL>
          <li>Go to your Facebook <strong>Settings &amp; Privacy → Settings</strong></li>
          <li>Open <strong>Apps and Websites</strong></li>
          <li>Find <strong>Autopilon.com</strong> and select <strong>Remove</strong></li>
        </OL>
        <P>This revokes our access. To also delete the data we already hold, follow Option 1 above, or email us.</P>
      </Section>

      <Section heading="Request deletion by email">
        <P>
          Email <a href="mailto:privacy@autopilon.com">privacy@autopilon.com</a> from the address registered
          to your account, with the subject "Data deletion request." We will verify your identity and confirm
          deletion within 30 days.
        </P>
      </Section>

      <Section heading="What we keep">
        <P>
          We retain records required by law — for example, billing and tax records — after account deletion.
          These contain no advertising, store, or Meta Platform Data.
        </P>
      </Section>
    </LegalLayout>
  );
}
