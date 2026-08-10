import 'package:flutter/material.dart';

class BuiltinSkill {
  final String id;
  final String name;
  final String description;
  final IconData icon;
  const BuiltinSkill({required this.id, required this.name, required this.description, required this.icon});
}

/// Mirrors client/src/lib/skills.js's BUILTIN_SKILLS exactly (same ids, same
/// order) — this is a static catalog on the web client too, not an API call,
/// so the mobile app keeps it as a const list rather than fetching it.
const List<BuiltinSkill> builtinSkills = [
  BuiltinSkill(id: 'general-assistant', name: 'General Assistant', description: 'Planning, writing, reasoning, everyday tasks.', icon: Icons.auto_awesome_outlined),
  BuiltinSkill(id: 'research', name: 'Research', description: 'Search the web, read pages, and build cited research reports.', icon: Icons.search),
  BuiltinSkill(id: 'content-creation', name: 'Content Creation', description: 'Draft posts and copy in a chosen voice.', icon: Icons.edit_outlined),
  BuiltinSkill(id: 'data-analysis', name: 'Data Analysis', description: 'Interpret tables and surface patterns.', icon: Icons.bar_chart_outlined),
  BuiltinSkill(id: 'marketing', name: 'Marketing', description: 'Plan campaigns, audiences, and messaging.', icon: Icons.campaign_outlined),
  BuiltinSkill(id: 'productivity', name: 'Productivity', description: 'Organize tasks, schedules, and workflows.', icon: Icons.checklist_outlined),
  BuiltinSkill(id: 'memory', name: 'Memory', description: 'Remember and recall information across conversations.', icon: Icons.psychology_outlined),
  BuiltinSkill(id: 'meta_ads', name: 'Meta Ads', description: 'Manage Meta ad campaigns once your account is connected.', icon: Icons.trending_up),
  BuiltinSkill(id: 'whatsapp', name: 'WhatsApp Business', description: 'Send and manage WhatsApp conversations once your account is connected.', icon: Icons.chat_outlined),
  BuiltinSkill(id: 'automations', name: 'Automations', description: 'Build and run automated workflows across your other skills and tools.', icon: Icons.bolt_outlined),
  BuiltinSkill(id: 'wordpress', name: 'WordPress', description: 'Manage posts, pages, and media once your site is connected.', icon: Icons.public_outlined),
  BuiltinSkill(id: 'woocommerce', name: 'WooCommerce', description: 'Manage products, orders, and customers once your store is connected.', icon: Icons.shopping_cart_outlined),
  BuiltinSkill(id: 'gmail', name: 'Gmail', description: 'Read, search, and send email once your account is connected.', icon: Icons.mail_outline),
  BuiltinSkill(id: 'calendar', name: 'Google Calendar', description: 'View and manage calendar events once your account is connected.', icon: Icons.calendar_today),
  BuiltinSkill(id: 'drive', name: 'Google Drive', description: 'List, search, create, and share Drive files once your account is connected.', icon: Icons.folder_outlined),
  BuiltinSkill(id: 'docs', name: 'Google Docs', description: 'Create, read, and edit Google Docs once your account is connected.', icon: Icons.description_outlined),
  BuiltinSkill(id: 'sheets', name: 'Google Sheets', description: 'Create spreadsheets and read/write cell data once your account is connected.', icon: Icons.table_chart_outlined),
  BuiltinSkill(id: 'shopify', name: 'Shopify', description: 'Manage products, orders, customers, inventory, discounts, and collections once your store is connected.', icon: Icons.storefront_outlined),
  BuiltinSkill(id: 'collaboration', name: 'Agent Collaboration', description: 'Delegate tasks to your other agents and chain them together on multi-step work.', icon: Icons.share_outlined),
  BuiltinSkill(id: 'custom_tools', name: 'Custom Tools (Developer)', description: "Use tools you've built and published yourself via the Developer SDK — each one calls a webhook you host.", icon: Icons.code_outlined),
];
