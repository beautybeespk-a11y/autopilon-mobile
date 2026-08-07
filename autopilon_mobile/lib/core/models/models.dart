class AppUser {
  final String id;
  final String name;
  final String email;
  final String? avatar;
  final bool isPlatformAdmin;

  AppUser({required this.id, required this.name, required this.email, this.avatar, this.isPlatformAdmin = false});

  factory AppUser.fromJson(Map<String, dynamic> json) => AppUser(
        id: json['id'] as String,
        name: json['name'] as String,
        email: json['email'] as String,
        avatar: json['avatar'] as String?,
        isPlatformAdmin: json['isPlatformAdmin'] == true,
      );
}

class Organization {
  final String id;
  final String name;
  final String? logoUrl;
  final String myRole;

  Organization({required this.id, required this.name, this.logoUrl, required this.myRole});

  factory Organization.fromJson(Map<String, dynamic> json) => Organization(
        id: json['id'] as String,
        name: json['name'] as String,
        logoUrl: json['logoUrl'] as String?,
        myRole: json['myRole'] as String? ?? 'member',
      );
}
