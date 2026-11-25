import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

type TabKey = 'Listings' | 'Chats' | 'Calls' | 'Profile';

interface UserProfile {
  user_uuid: string;
  display_name: string;
  role: string;
  city?: string;
  allow_calls: boolean;
  show_contact_after_consent: boolean;
  masked_handle: string;
}

interface ListingItem {
  id: string;
  title: string;
  locality: string;
  city?: string;
  price_inr: number;
  verification_status?: string;
}

interface ChatRoomItem {
  id: string;
  room_type: string;
  title: string;
  participant_uuids: string[];
}

interface CallLogItem {
  call_id: string;
  mode: string;
  state: string;
  duration_seconds: number;
  started_at: string;
}

const API_BASE = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8000/api/v1';

function formatInr(amount: number): string {
  if (amount >= 10_000_000) {
    return `INR ${(amount / 10_000_000).toFixed(2)} Cr`;
  }
  return `INR ${(amount / 100_000).toFixed(1)} L`;
}

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState<string | null>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('Listings');
  const [listings, setListings] = useState<ListingItem[]>([]);
  const [chats, setChats] = useState<ChatRoomItem[]>([]);
  const [callLogs, setCallLogs] = useState<CallLogItem[]>([]);
  const [email, setEmail] = useState('aarav.buyer@landconnect.in');
  const [password, setPassword] = useState('LandConnect@2026');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);

  const signIn = async (targetEmail: string) => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: targetEmail.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAuthError(typeof data.detail === 'string' ? data.detail : 'Unable to sign in');
        return;
      }
      setToken(data.access_token);
      setRefreshToken(data.refresh_token || null);
      setUser(data.user);
    } catch {
      setAuthError('Network error connecting to LandConnect API');
    } finally {
      setAuthLoading(false);
    }
  };

  const signOut = async () => {
    if (refreshToken) {
      await fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      }).catch(() => {});
    }
    setToken(null);
    setRefreshToken(null);
    setUser(null);
    setListings([]);
    setChats([]);
    setCallLogs([]);
    setActiveTab('Listings');
  };

  const fetchTabData = useCallback(async () => {
    if (!token) return;
    setDataLoading(true);
    setDataError(null);
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [listRes, chatRes, callRes] = await Promise.all([
        fetch(`${API_BASE}/listings`, { headers }),
        fetch(`${API_BASE}/chats`, { headers }),
        fetch(`${API_BASE}/calls/logs`, { headers }),
      ]);
      if (listRes.ok) {
        const listJson = await listRes.json();
        setListings(Array.isArray(listJson) ? listJson : listJson.listings || []);
      }
      if (chatRes.ok) {
        const chatJson = await chatRes.json();
        setChats(chatJson.chats || []);
      }
      if (callRes.ok) {
        const callJson = await callRes.json();
        setCallLogs(callJson.logs || []);
      }
    } catch {
      setDataError('Failed to refresh workspace data');
    } finally {
      setDataLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchTabData();
  }, [fetchTabData]);

  const updatePrivacy = async (patch: { allow_calls?: boolean; show_contact_after_consent?: boolean }) => {
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/auth/privacy`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const updated = await res.json();
        setUser(updated);
      }
    } catch {
      setDataError('Could not update privacy settings');
    }
  };

  if (!user) {
    return (
      <SafeAreaView style={styles.authContainer}>
        <Text style={styles.brand}>LandConnect</Text>
        <Text style={styles.subtitle}>Verified Land Parcels & Private Deal Rooms</Text>
        {authError ? <Text style={styles.errorBanner}>{authError}</Text> : null}
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          placeholder="Email"
        />
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          placeholder="Password"
        />
        <TouchableOpacity
          style={styles.primaryBtn}
          disabled={authLoading}
          onPress={() => signIn(email)}
        >
          <Text style={styles.primaryBtnText}>{authLoading ? 'Signing in...' : 'Sign In'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.secondaryBtn}
          disabled={authLoading}
          onPress={() => signIn('rahul.broker@landconnect.in')}
        >
          <Text style={styles.secondaryBtnText}>1-Click Broker Demo (Rahul)</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.shell}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>LandConnect · {activeTab}</Text>
        <Text style={styles.headerMeta}>{user.role}</Text>
      </View>

      <ScrollView style={styles.body}>
        {dataLoading ? <ActivityIndicator color="#008069" style={styles.loader} /> : null}
        {dataError ? <Text style={styles.errorBanner}>{dataError}</Text> : null}

        {activeTab === 'Listings' &&
          (listings.length === 0 && !dataLoading ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>No parcels match yet</Text>
              <Text style={styles.cardMeta}>Pull or tap refresh to check for new land listings.</Text>
            </View>
          ) : (
            listings.map((item) => (
              <View key={item.id} style={styles.card}>
                <Text style={styles.cardTitle}>{item.title}</Text>
                <Text style={styles.cardMeta}>
                  {item.locality}
                  {item.city ? `, ${item.city}` : ''} · {formatInr(item.price_inr)}
                </Text>
              </View>
            ))
          ))}

        {activeTab === 'Chats' &&
          (chats.length === 0 && !dataLoading ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>No active deal rooms</Text>
              <Text style={styles.cardMeta}>Start an inquiry on any parcel to open a private thread.</Text>
            </View>
          ) : (
            chats.map((room) => (
              <View key={room.id} style={styles.card}>
                <Text style={styles.cardTitle}>{room.title}</Text>
                <Text style={styles.cardMeta}>
                  {room.room_type === 'MEETING_ROOM' ? 'Broker Deal Room' : 'Direct Thread'} ·{' '}
                  {room.participant_uuids.length} participants
                </Text>
              </View>
            ))
          ))}

        {activeTab === 'Calls' &&
          (callLogs.length === 0 && !dataLoading ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>No recent calls</Text>
              <Text style={styles.cardMeta}>Audio and video briefings from Deal Rooms appear here.</Text>
            </View>
          ) : (
            callLogs.map((log) => (
              <View key={log.call_id} style={styles.card}>
                <Text style={styles.cardTitle}>
                  {log.mode} Call · {log.state}
                </Text>
                <Text style={styles.cardMeta}>
                  Duration: {log.duration_seconds}s · {new Date(log.started_at).toLocaleString()}
                </Text>
              </View>
            ))
          ))}

        {activeTab === 'Profile' && (
          <View>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{user.display_name}</Text>
              <Text style={styles.cardMeta}>
                {user.masked_handle} · {user.role}
              </Text>
            </View>
            <View style={styles.card}>
              <View style={styles.switchRow}>
                <View style={styles.switchCopy}>
                  <Text style={styles.cardTitle}>Allow In-App Calls</Text>
                  <Text style={styles.cardMeta}>Permit verified room peers to initiate calls</Text>
                </View>
                <Switch
                  value={user.allow_calls}
                  onValueChange={(val) => updatePrivacy({ allow_calls: val })}
                />
              </View>
            </View>
            <View style={styles.card}>
              <View style={styles.switchRow}>
                <View style={styles.switchCopy}>
                  <Text style={styles.cardTitle}>Require Consent Before Contact Reveal</Text>
                  <Text style={styles.cardMeta}>Keep email and phone masked until mutual consent</Text>
                </View>
                <Switch
                  value={user.show_contact_after_consent}
                  onValueChange={(val) => updatePrivacy({ show_contact_after_consent: val })}
                />
              </View>
            </View>
            <TouchableOpacity style={styles.logoutBtn} onPress={signOut}>
              <Text style={styles.logoutBtnText}>Sign Out</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      <View style={styles.tabBar}>
        {(['Listings', 'Chats', 'Calls', 'Profile'] as TabKey[]).map((tab) => (
          <TouchableOpacity
            key={tab}
            style={styles.tabBtn}
            onPress={() => setActiveTab(tab)}
          >
            <Text style={[styles.tabLabel, activeTab === tab && styles.tabLabelActive]}>
              {tab}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  authContainer: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#F4F6F4' },
  brand: { fontSize: 28, fontWeight: '700', color: '#075E54' },
  subtitle: { fontSize: 13, color: '#475569', marginBottom: 24, marginTop: 4 },
  errorBanner: {
    backgroundColor: '#FEE2E2',
    color: '#991B1B',
    padding: 10,
    borderRadius: 10,
    marginBottom: 12,
    fontSize: 13,
  },
  loader: { marginVertical: 12 },
  input: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  primaryBtn: { backgroundColor: '#008069', borderRadius: 12, padding: 14, alignItems: 'center' },
  primaryBtnText: { color: '#FFFFFF', fontWeight: '600' },
  secondaryBtn: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#008069',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
  },
  secondaryBtnText: { color: '#075E54', fontWeight: '600' },
  shell: { flex: 1, backgroundColor: '#F4F6F4' },
  header: {
    height: 56,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitle: { fontSize: 16, fontWeight: '700', color: '#075E54' },
  headerMeta: { fontSize: 12, color: '#64748B' },
  body: { flex: 1, padding: 16 },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  cardTitle: { fontSize: 15, fontWeight: '600', color: '#111B21' },
  cardMeta: { fontSize: 12, color: '#64748B', marginTop: 4 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  switchCopy: { flex: 1 },
  logoutBtn: {
    marginTop: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#FCA5A5',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
  },
  logoutBtnText: { color: '#B91C1C', fontWeight: '600' },
  tabBar: {
    height: 60,
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderColor: '#E2E8F0',
    flexDirection: 'row',
  },
  tabBtn: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tabLabel: { fontSize: 12, color: '#64748B', fontWeight: '500' },
  tabLabelActive: { color: '#008069', fontWeight: '700' },
});
