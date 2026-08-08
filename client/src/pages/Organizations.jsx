import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, Plus, Check } from "lucide-react";
import { Card, Button, Badge, Input, EmptyState } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";

export default function Organizations() {
  const [orgs, setOrgs] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [currentOrgId, setCurrentOrgId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const load = () => {
    api.get("/organizations").then(setOrgs).catch(() => {});
    api.get("/organizations/invitations").then(setInvitations).catch(() => {});
    api.get("/organizations/current").then((d) => setCurrentOrgId(d.orgId)).catch(() => {});
  };
  useEffect(load, []);

  const create = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const org = await api.post("/organizations", { name: newName });
      setNewName(""); setCreating(false);
      navigate(`/app/organizations/${org.id}`);
    } finally { setBusy(false); }
  };

  const switchTo = async (orgId) => {
    await api.post("/organizations/switch", { orgId });
    setCurrentOrgId(orgId);
  };

  const respond = async (invId, accept) => {
    await api.post(`/organizations/invitations/${invId}/${accept ? "accept" : "decline"}`, {});
    load();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold">Organizations</h1>
          <p className="mt-1 text-muted">Switch between organizations, or keep working in personal mode.</p>
        </div>
        <Button onClick={() => setCreating(true)}><Plus size={16} /> New organization</Button>
      </div>

      {creating && (
        <Card className="flex items-end gap-3 p-5">
          <div className="flex-1"><Input label="Organization name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. BeautyBees" /></div>
          <Button onClick={create} disabled={busy || !newName.trim()}>{busy ? "Creating…" : "Create"}</Button>
          <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
        </Card>
      )}

      {invitations.length > 0 && (
        <Card className="p-5">
          <h3 className="font-display font-semibold">Pending invitations</h3>
          <div className="mt-3 space-y-2">
            {invitations.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between rounded-xl border border-line p-3">
                <div><div className="font-medium">{inv.orgName}</div><div className="text-xs text-muted">Invited as {inv.role}</div></div>
                <div className="flex gap-2">
                  <Button onClick={() => respond(inv.id, true)}>Accept</Button>
                  <Button variant="outline" onClick={() => respond(inv.id, false)}>Decline</Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-5">
        <div className="flex items-center justify-between rounded-xl border border-line p-3">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-lg bg-elevated text-muted"><Building2 size={16} /></div>
            <div className="font-medium">Personal (no organization)</div>
          </div>
          {currentOrgId === null ? <Badge tone="success"><Check size={12} className="mr-1 inline" />Active</Badge> : <Button variant="outline" onClick={() => switchTo(null)}>Switch to this</Button>}
        </div>
      </Card>

      {orgs.length === 0 ? (
        <EmptyState icon={Building2} title="No organizations yet" description="Create one to invite teammates, share agents, and manage roles together." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {orgs.map((o) => (
            <Card key={o.id} className="p-5">
              <div className="flex items-start justify-between">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-accent/10 text-accent"><Building2 size={20} /></div>
                {currentOrgId === o.id && <Badge tone="success">Active</Badge>}
              </div>
              <h3 className="mt-3 font-display font-semibold">{o.name}</h3>
              <Badge tone="muted">{o.myRole}</Badge>
              <div className="mt-4 flex gap-2">
                <Button className="flex-1" variant="outline" onClick={() => navigate(`/app/organizations/${o.id}`)}>Manage</Button>
                {currentOrgId !== o.id && <Button onClick={() => switchTo(o.id)}>Switch</Button>}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
