import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// True whenever the device reports a network connection. Note this is
/// "connected to some network," not "can reach the Autopilon server" — a
/// wifi network without internet still counts as connected here, same
/// caveat connectivity_plus itself documents. Good enough to decide when
/// to show the offline banner and fall back to cached data.
final isOnlineProvider = StreamProvider<bool>((ref) {
  final connectivity = Connectivity();
  return connectivity.onConnectivityChanged.map((results) => !results.contains(ConnectivityResult.none));
});
