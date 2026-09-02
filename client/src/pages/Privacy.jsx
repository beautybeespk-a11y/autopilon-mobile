import LegalLayout, { Section, P, UL } from "../components/LegalLayout.jsx";

// Public, no-login page — registered at /privacy in App.jsx, outside the
// /app ProtectedRoute. Content is the reviewed Privacy Policy text
// supplied for App Review (Meta requires this URL in App Settings ->
// Basic before an app can be published) — transcribed faithfully, no
// placeholder values left in.
export default function Privacy() {
  return (
    <LegalLayout title="Privacy Policy" lastUpdated="September 2, 2026">
      <P>
        Autopilon ("Autopilon") is operated by Moazzam Iqbal, Scheme 33 Karachi, Pakistan. This policy
        explains what information we collect, why we collect it, how we use it, and how you can delete it.
      </P>
      <P>
        If you have questions, contact us at <a href="mailto:privacy@autopilon.com">privacy@autopilon.com</a>.
      </P>

      <Section heading="Who this policy covers">
        <P>
          This policy applies to everyone who uses Autopilon at autopilon.com, including our AI agents for
          advertising, store management, content, and support.
        </P>
      </Section>

      <Section heading="What we collect">
        <P>
          <strong>Account information.</strong> Your name, email address, and password (stored hashed, never
          in plain text). Autopilon does not currently charge for the service. If we introduce paid plans, we
          will update this policy before doing so.
        </P>
        <P>
          <strong>Information from connected services.</strong> When you connect an account, we receive only
          what you authorise:
        </P>
        <UL>
          <li>
            <strong>Meta (Facebook and Instagram).</strong> Ad account IDs, campaign, ad set and ad data,
            advertising performance metrics, Facebook Page IDs and posts, Instagram media, Meta Pixel IDs and
            event data, product catalog data, and the business portfolios you grant access to.
          </li>
          <li><strong>WooCommerce and Shopify.</strong> Product names, descriptions, images, prices, categories, and store settings.</li>
          <li><strong>Other services you connect</strong>, limited to the permissions you grant at the time of connection.</li>
        </UL>
        <P>
          <strong>Access tokens.</strong> We store the access tokens these services issue, so our agents can
          act on your behalf. Tokens are stored encrypted and are used only to perform actions you have
          requested or approved.
        </P>
        <P>
          <strong>Conversations with our agents.</strong> The messages you send to Autopilon agents and the
          agents' replies, so that conversations have continuity and you can review what was done on your
          behalf.
        </P>
        <P><strong>Technical information.</strong> IP address, browser type, and timestamps, kept for security and troubleshooting.</P>
      </Section>

      <Section heading="What we do with it">
        <P>We use your information only to:</P>
        <UL>
          <li>Operate the service you asked for — for example, reading your store's products in order to recommend and build an advertising campaign</li>
          <li>Create, modify, and report on advertising campaigns <strong>that you approve</strong></li>
          <li>Maintain your account, provide support, and process payments</li>
          <li>Detect abuse, prevent fraud, and keep the service secure</li>
          <li>Comply with legal obligations</li>
        </UL>
        <P>
          <strong>We do not sell your data. We do not share it with advertisers, data brokers, or any third
          party for their own marketing.</strong> We do not use your business data to advertise to you or
          anyone else.
        </P>
      </Section>

      <Section heading="Automated decisions and your approval">
        <P>Autopilon uses artificial intelligence to analyse your business data and recommend advertising actions.</P>
        <P>
          <strong>No campaign is created, changed, or given a budget without your explicit approval.</strong>{" "}
          Campaigns we create are paused by default and do not spend money until you choose to activate them.
          Where you enable any automated feature in the future, its limits are shown to you and remain under
          your control, and you can disable it at any time.
        </P>
      </Section>

      <Section heading="Who we share it with">
        <P>We share information only with service providers who help us run Autopilon, and only to the extent they need it:</P>
        <UL>
          <li>HOSTINGER — server hosting and storage</li>
          <li>Open AI — processing your requests and generating agent responses</li>
          <li>HOSTINGER — transactional email</li>
        </UL>
        <P>We may also disclose information where required by law, or to protect the rights, safety, or property of Autopilon or our users.</P>
      </Section>

      <Section heading="Meta Platform Data">
        <P>Data we receive from Meta's APIs ("Platform Data") is handled in accordance with the Meta Platform Terms and Developer Policies. Specifically:</P>
        <UL>
          <li>We use Platform Data only to provide the features you have asked for</li>
          <li>We do not sell, license, or transfer Platform Data to any third party for their own purposes</li>
          <li>We do not use Platform Data to build user profiles for advertising, or to make eligibility decisions about credit, employment, insurance, housing, or similar</li>
          <li>We retain Platform Data only as long as needed to provide the service, and delete it when you disconnect your Meta account or close your account</li>
          <li>We do not attempt to re-identify anonymised or aggregated Platform Data</li>
        </UL>
      </Section>

      <Section heading="How long we keep it">
        <P>
          We keep your account information and business data for as long as your account is active. When you
          disconnect an integration, the tokens and cached data for that integration are deleted. When you
          close your account, we delete your personal data within <strong>30 days</strong>, apart from records
          we are required by law to retain — for example, invoices for tax purposes.
        </P>
        <P>Encrypted backups are retained for <strong>30 days</strong> and are then permanently overwritten.</P>
      </Section>

      <Section heading="How we protect it">
        <P>
          Access tokens are stored encrypted. All traffic to autopilon.com is served over HTTPS. Access to
          production systems is limited to authorised personnel. No system is perfectly secure, and we cannot
          guarantee absolute security, but we take reasonable steps to protect your information and will
          notify you of any breach affecting your data as required by law.
        </P>
      </Section>

      <Section heading="Your rights">
        <P>You can, at any time:</P>
        <UL>
          <li>Access the information we hold about you</li>
          <li>Correct anything inaccurate</li>
          <li>Delete your account and the data associated with it</li>
          <li>Disconnect any integration, which removes our access to that service</li>
          <li>Export your data</li>
          <li>Object to or restrict certain processing</li>
        </UL>
        <P>
          To exercise any of these, use the controls in your account settings or email{" "}
          <a href="mailto:privacy@autopilon.com">privacy@autopilon.com</a>. We respond within <strong>30 days</strong>.
        </P>
        <P>
          Depending on where you live, you may have additional rights under laws such as the GDPR or CCPA, and
          the right to complain to your local data protection authority.
        </P>
      </Section>

      <Section heading="Children">
        <P>
          Autopilon is a business tool and is not directed at children. We do not knowingly collect
          information from anyone under 18. If we learn we have, we delete it.
        </P>
      </Section>

      <Section heading="International transfers">
        <P>
          Our servers are located in Malaysia — Kuala Lumpur. If you use Autopilon from another country, your
          information is transferred to and processed there.
        </P>
      </Section>

      <Section heading="Changes">
        <P>
          We may update this policy. If we make a material change, we will notify you by email or through the
          service before it takes effect. The date at the top shows when it was last revised.
        </P>
      </Section>

      <Section heading="Contact">
        <P>
          Moazzam Iqbal<br />
          Scheme 33 Karachi, Pakistan<br />
          Email: <a href="mailto:privacy@autopilon.com">privacy@autopilon.com</a>
        </P>
      </Section>
    </LegalLayout>
  );
}
