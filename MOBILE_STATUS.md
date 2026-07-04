# Mobile App Status

> **Repo:** [VinceCarter12/OracleSalesApp-Mobile](https://github.com/VinceCarter12/OracleSalesApp-Mobile)
> **Branch:** `main`
> **Last synced:** Jul 4, 2026, 08:40 PM GMT+8
> Run `npm run mobile:status` to refresh.

---

## Latest Commits on `main`

1. [`9e60e00`](https://github.com/VinceCarter12/OracleSalesApp-Mobile/commit/9e60e00802bb5c356deb8cb8501db6a575f58c6d) **docs: use npm ci in setup instructions** — Vince Carter U. Delostrico · Jul 2, 2026, 05:44 PM GMT+8
2. [`0969f7b`](https://github.com/VinceCarter12/OracleSalesApp-Mobile/commit/0969f7b6445c6107771dd9d43140e8e99d67e133) **chore(deps): pin babel-preset-expo and fix tamagui babel plugin resolution** — Vince Carter U. Delostrico · Jul 2, 2026, 05:40 PM GMT+8
3. [`b20122e`](https://github.com/VinceCarter12/OracleSalesApp-Mobile/commit/b20122e3d9ebdc47f46dd5874cdb2855c07c283b) **fix: add react-dom required by Tamagui for Android build** — Vince Carter U. Delostrico · Jul 2, 2026, 04:51 PM GMT+8
4. [`61708d0`](https://github.com/VinceCarter12/OracleSalesApp-Mobile/commit/61708d0f7e03691f12e12b86a2bcea1bfe67769f) **docs: update setup guide to use Android Studio for local development** — Vince Carter U. Delostrico · Jul 2, 2026, 02:30 PM GMT+8
5. [`48f594d`](https://github.com/VinceCarter12/OracleSalesApp-Mobile/commit/48f594dbcaafa9f97b69a40a61ba13a65f87c5bd) **chore: add .npmrc with legacy-peer-deps for EAS build** — Vince Carter U. Delostrico · Jul 2, 2026, 02:14 PM GMT+8
6. [`7a723f9`](https://github.com/VinceCarter12/OracleSalesApp-Mobile/commit/7a723f9179a6f5175b970db55b1fc9034946c77a) **chore: link EAS project to vincecarter123 account** — Vince Carter U. Delostrico · Jul 2, 2026, 02:12 PM GMT+8
7. [`1634abf`](https://github.com/VinceCarter12/OracleSalesApp-Mobile/commit/1634abf026630bf981382738b94d335bbeb5d2bb) **chore: add expo-dev-client** — Vince Carter U. Delostrico · Jul 2, 2026, 01:55 PM GMT+8
8. [`d132123`](https://github.com/VinceCarter12/OracleSalesApp-Mobile/commit/d13212320fbfc53366ab8a0020a34eb195e64970) **chore: link EAS project to oracle-devops account** — Vince Carter U. Delostrico · Jul 2, 2026, 01:51 PM GMT+8
9. [`f571ad2`](https://github.com/VinceCarter12/OracleSalesApp-Mobile/commit/f571ad2d50ddb98f4304b4162f7cc7b7971ea5db) **docs: remove open questions section from README** — Vince Carter U. Delostrico · Jul 2, 2026, 01:02 PM GMT+8
10. [`2af096e`](https://github.com/VinceCarter12/OracleSalesApp-Mobile/commit/2af096ea6a52dbd3b4bde119e8dbaca2bd90a8c8) **docs: remove app overview, roles, and features sections from README** — Vince Carter U. Delostrico · Jul 2, 2026, 12:52 PM GMT+8

---

## Recently Merged Pull Requests

_No recently merged PRs found._

---

## Config & Environment Files

#### `package.json`

```json
{
  "name": "oracle-sales-app",
  "version": "1.0.0",
  "main": "index.ts",
  "dependencies": {
    "@supabase/supabase-js": "^2.110.0",
    "@tamagui/babel-plugin": "^2.4.0",
    "@tamagui/config": "^2.4.0",
    "@tamagui/core": "^2.4.0",
    "expo": "~57.0.1",
    "expo-camera": "~57.0.0",
    "expo-constants": "~57.0.2",
    "expo-dev-client": "~57.0.4",
    "expo-image-picker": "~57.0.1",
    "expo-linking": "~57.0.1",
    "expo-location": "~57.0.1",
    "expo-router": "~57.0.2",
    "expo-secure-store": "~57.0.0",
    "expo-status-bar": "~57.0.0",
    "react": "19.2.3",
    "react-dom": "19.2.3",
    "react-native": "0.86.0",
    "react-native-safe-area-context": "~5.7.0",
    "react-native-screens": "4.25.2",
    "tamagui": "^2.4.0"
  },
  "devDependencies": {
    "@babel/core": "^7.24.0",
    "@types/react": "~19.2.2",
    "babel-preset-expo": "^57.0.1",
    "typescript": "~6.0.3"
  },
  "scripts": {
    "start": "expo start",
    "android": "expo run:android",
    "ios": "expo run:ios",
    "web": "expo start --web",
    "lint": "expo lint",
    "build:dev:android": "eas build --profile development --platform android",
    "build:preview:android": "eas build --profile preview --platform android",
    "build:prod:android": "eas build --profile production --platform android",
    "build:prod:apk": "eas build --profile production-apk --platform android"
  },
  "private": true
}
```

#### `app.json`

```json
{
  "expo": {
    "name": "Oracle Sales App",
    "slug": "OracleSalesApp",
    "version": "1.0.0",
    "orientation": "portrait",
    "icon": "./assets/icon.png",
    "userInterfaceStyle": "light",
    "scheme": "oracle-sales",
    "ios": {
      "supportsTablet": true,
      "bundleIdentifier": "com.oracle.salesapp",
      "infoPlist": {
        "NSCameraUsageDescription": "Used to capture selfies during client meetings.",
        "NSLocationWhenInUseUsageDescription": "Used to record GPS location when logging a client meeting.",
        "NSPhotoLibraryUsageDescription": "Used to save and retrieve meeting photos."
      }
    },
    "android": {
      "package": "com.oracle.salesapp",
      "adaptiveIcon": {
        "foregroundImage": "./assets/icon.png",
        "backgroundColor": "#003087"
      },
      "permissions": [
        "android.permission.CAMERA",
        "android.permission.ACCESS_FINE_LOCATION",
        "android.permission.ACCESS_COARSE_LOCATION",
        "android.permission.READ_EXTERNAL_STORAGE",
        "android.permission.WRITE_EXTERNAL_STORAGE",
        "android.permission.RECORD_AUDIO"
      ]
    },
    "web": {
      "favicon": "./assets/icon.png",
      "bundler": "metro"
    },
    "plugins": [
      "expo-router",
      "expo-status-bar",
      "expo-secure-store",
      [
        "expo-camera",
        {
          "cameraPermission": "Used to capture selfies during client meetings."
        }
      ],
      [
        "expo-location",
        {
          "locationAlwaysAndWhenInUsePermission": "Used to record GPS when logging a client meeting."
        }
      ],
      [
        "expo-image-picker",
        {
          "photosPermission": "Used to save meeting photos to your gallery."
        }
      ]
    ],
    "experiments": {
      "typedRoutes": true
    },
    "extra": {
      "router": {},
      "eas": {
        "projectId": "88e83142-28ca-439f-8e88-4da233d9fa5c"
      }
    },
    "owner": "vincecarter123"
  }
}
```

#### `.env.local.example`

```text
# Supabase — ask the project lead for values. NEVER commit the real .env.local
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
```

---

## Source Files (15 files)

> Fetched live from `main`. Any new file added to the mobile repo
> will automatically appear here on the next run.

### `app/`

#### `app/_layout.tsx`

```typescript
import { TamaguiProvider } from 'tamagui';
import { Stack, Redirect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import tamaguiConfig from '../tamagui.config';
import { useAuth } from '../lib/useAuth';

export default function RootLayout() {
  const { session, loading } = useAuth();

  if (loading) return null;

  return (
    <TamaguiProvider config={tamaguiConfig}>
      <StatusBar style="auto" />
      {!session ? (
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(auth)" />
        </Stack>
      ) : (
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
        </Stack>
      )}
    </TamaguiProvider>
  );
}
```

### `app/(auth)/`

#### `app/(auth)/_layout.tsx`

```typescript
import { Stack } from 'expo-router';

export default function AuthLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" />
    </Stack>
  );
}
```

#### `app/(auth)/login.tsx`

```typescript
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { Button, Input, Label, Spinner, Text, YStack } from 'tamagui';
import { supabase } from '../../lib/supabase';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleLogin() {
    if (!email || !password) {
      Alert.alert('Error', 'Please enter your email and password.');
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) Alert.alert('Login Failed', error.message);
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <YStack flex={1} justifyContent="center" padding="$6" gap="$4" backgroundColor="$background">
        <Text fontSize="$8" fontWeight="700" textAlign="center" color="$color">
          Oracle Sales
        </Text>
        <Text fontSize="$4" textAlign="center" color="$colorPress">
          Field Agent App
        </Text>

        <YStack gap="$2" marginTop="$4">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            placeholder="agent@oraclecorp.com"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            size="$4"
          />
        </YStack>

        <YStack gap="$2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            placeholder="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            size="$4"
          />
        </YStack>

        <Button
          size="$4"
          marginTop="$4"
          onPress={handleLogin}
          disabled={loading}
          theme="active"
          icon={loading ? <Spinner /> : undefined}
        >
          {loading ? 'Signing in…' : 'Sign In'}
        </Button>
      </YStack>
    </KeyboardAvoidingView>
  );
}
```

### `app/(tabs)/`

#### `app/(tabs)/_layout.tsx`

```typescript
import { Tabs } from 'expo-router';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: '#003087',
        headerShown: true,
      }}
    >
      <Tabs.Screen
        name="clients"
        options={{
          title: 'Clients',
          headerTitle: 'Clients',
        }}
      />
      <Tabs.Screen
        name="meetings"
        options={{
          title: 'Meetings',
          headerTitle: 'Meetings',
        }}
      />
    </Tabs>
  );
}
```

### `app/(tabs)/clients/`

#### `app/(tabs)/clients/[id].tsx`

```typescript
import { useEffect, useState } from 'react';
import { Alert, ScrollView } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Button, Separator, Spinner, Text, XStack, YStack } from 'tamagui';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../lib/useAuth';
import type { Client } from '../../../types';

export default function ClientDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session } = useAuth();
  const [client, setClient] = useState<Client | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    supabase
      .from('clients')
      .select('*')
      .eq('id', id)
      .single()
      .then(({ data, error }) => {
        if (error) Alert.alert('Error', error.message);
        else setClient(data);
        setLoading(false);
      });
  }, [id]);

  if (loading) {
    return (
      <YStack flex={1} justifyContent="center" alignItems="center">
        <Spinner size="large" />
      </YStack>
    );
  }

  if (!client) {
    return (
      <YStack flex={1} justifyContent="center" alignItems="center" padding="$6">
        <Text>Client not found.</Text>
      </YStack>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
      <YStack flex={1} padding="$6" gap="$4" backgroundColor="$background">
        <Text fontSize="$7" fontWeight="700">{client.company_name}</Text>

        <Separator />

        <YStack gap="$1">
          <Text fontSize="$3" color="$colorPress">Contact Person</Text>
          <Text fontSize="$4">{client.contact_person || '—'}</Text>
        </YStack>
        <YStack gap="$1">
          <Text fontSize="$3" color="$colorPress">Customer Type</Text>
          <Text fontSize="$4">{client.customer_type}</Text>
        </YStack>
        <YStack gap="$1">
          <Text fontSize="$3" color="$colorPress">Sales Channel</Text>
          <Text fontSize="$4">{client.sales_channel}</Text>
        </YStack>
        <YStack gap="$1">
          <Text fontSize="$3" color="$colorPress">Added</Text>
          <Text fontSize="$4">{new Date(client.created_at).toLocaleDateString()}</Text>
        </YStack>

        <Separator />

        <Button
          size="$4"
          theme="active"
          onPress={() => router.push(`/(tabs)/meetings/record?clientId=${client.id}`)}
        >
          Record Meeting
        </Button>
      </YStack>
    </ScrollView>
  );
}
```

#### `app/(tabs)/clients/create.tsx`

```typescript
import { useState } from 'react';
import { Alert, ScrollView } from 'react-native';
import { router } from 'expo-router';
import { Button, Input, Label, Select, Spinner, Text, YStack } from 'tamagui';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../lib/useAuth';
import { CUSTOMER_TYPES, SALES_CHANNELS } from '../../../types';

export default function CreateClientScreen() {
  const { session } = useAuth();
  const [companyName, setCompanyName] = useState('');
  const [contactPerson, setContactPerson] = useState('');
  const [customerType, setCustomerType] = useState<string>(CUSTOMER_TYPES[0]);
  const [salesChannel, setSalesChannel] = useState<string>(SALES_CHANNELS[0]);
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    if (!companyName.trim()) {
      Alert.alert('Validation', 'Company name is required.');
      return;
    }
    setLoading(true);

    // Duplicate check
    const { data: existing } = await supabase
      .from('clients')
      .select('id')
      .ilike('company_name', companyName.trim())
      .limit(1);

    if (existing && existing.length > 0) {
      setLoading(false);
      Alert.alert('Duplicate', 'A client with this company name already exists.');
      return;
    }

    const { error } = await supabase.from('clients').insert({
      company_name: companyName.trim(),
      contact_person: contactPerson.trim(),
      customer_type: customerType,
      sales_channel: salesChannel,
      agent_id: session?.user.id,
    });

    setLoading(false);
    if (error) {
      Alert.alert('Error', error.message);
    } else {
      router.back();
    }
  }

  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
      <YStack flex={1} padding="$6" gap="$4" backgroundColor="$background">
        <Text fontSize="$6" fontWeight="700">New Client</Text>

        <YStack gap="$2">
          <Label>Company Name *</Label>
          <Input
            placeholder="Acme Corporation"
            value={companyName}
            onChangeText={setCompanyName}
            size="$4"
          />
        </YStack>

        <YStack gap="$2">
          <Label>Contact Person</Label>
          <Input
            placeholder="Juan Dela Cruz"
            value={contactPerson}
            onChangeText={setContactPerson}
            size="$4"
          />
        </YStack>

        <YStack gap="$2">
          <Label>Customer Type</Label>
          <Select value={customerType} onValueChange={setSalesChannel} disablePreventBodyScroll>
            <Select.Trigger size="$4">
              <Select.Value placeholder="Select type" />
            </Select.Trigger>
            <Select.Content>
              <Select.ScrollUpButton />
              <Select.Viewport>
                {CUSTOMER_TYPES.map((type, i) => (
                  <Select.Item key={type} index={i} value={type}>
                    <Select.ItemText>{type}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.Viewport>
              <Select.ScrollDownButton />
            </Select.Content>
          </Select>
        </YStack>

        <YStack gap="$2">
          <Label>Sales Channel</Label>
          <Select value={salesChannel} onValueChange={setSalesChannel} disablePreventBodyScroll>
            <Select.Trigger size="$4">
              <Select.Value placeholder="Select channel" />
            </Select.Trigger>
            <Select.Content>
              <Select.ScrollUpButton />
              <Select.Viewport>
                {SALES_CHANNELS.map((ch, i) => (
                  <Select.Item key={ch} index={i} value={ch}>
                    <Select.ItemText>{ch}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.Viewport>
              <Select.ScrollDownButton />
            </Select.Content>
          </Select>
        </YStack>

        <Button
          size="$4"
          marginTop="$4"
          onPress={handleSubmit}
          disabled={loading}
          theme="active"
          icon={loading ? <Spinner /> : undefined}
        >
          {loading ? 'Saving…' : 'Create Client'}
        </Button>
      </YStack>
    </ScrollView>
  );
}
```

#### `app/(tabs)/clients/index.tsx`

```typescript
import { useEffect, useState } from 'react';
import { FlatList, RefreshControl } from 'react-native';
import { Link } from 'expo-router';
import { Button, Separator, Spinner, Text, XStack, YStack } from 'tamagui';
import { useClients } from '../../../lib/useClients';
import type { Client } from '../../../types';

function ClientRow({ client }: { client: Client }) {
  return (
    <Link href={`/(tabs)/clients/${client.id}`} asChild>
      <YStack padding="$4" gap="$1" pressStyle={{ opacity: 0.7 }}>
        <Text fontWeight="600" fontSize="$4">{client.company_name}</Text>
        <Text fontSize="$3" color="$colorPress">{client.contact_person}</Text>
        <Text fontSize="$2" color="$colorPress">{client.customer_type} · {client.sales_channel}</Text>
      </YStack>
    </Link>
  );
}

export default function ClientsScreen() {
  const { clients, loading, refresh } = useClients();

  return (
    <YStack flex={1} backgroundColor="$background">
      <XStack padding="$4" justifyContent="flex-end">
        <Link href="/(tabs)/clients/create" asChild>
          <Button size="$3" theme="active">+ New Client</Button>
        </Link>
      </XStack>

      {loading && !clients.length ? (
        <YStack flex={1} justifyContent="center" alignItems="center">
          <Spinner size="large" />
        </YStack>
      ) : (
        <FlatList
          data={clients}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <ClientRow client={item} />}
          ItemSeparatorComponent={() => <Separator />}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} />}
          ListEmptyComponent={
            <YStack flex={1} justifyContent="center" alignItems="center" padding="$8">
              <Text color="$colorPress">No clients yet. Tap "+ New Client" to add one.</Text>
            </YStack>
          }
        />
      )}
    </YStack>
  );
}
```

### `app/(tabs)/meetings/`

#### `app/(tabs)/meetings/index.tsx`

```typescript
import { FlatList, RefreshControl } from 'react-native';
import { Link } from 'expo-router';
import { Button, Separator, Spinner, Text, XStack, YStack } from 'tamagui';
import { useMeetings } from '../../../lib/useMeetings';
import type { Meeting } from '../../../types';

function MeetingRow({ meeting }: { meeting: Meeting }) {
  return (
    <YStack padding="$4" gap="$1">
      <Text fontWeight="600" fontSize="$4">{meeting.client_name ?? 'Unknown Client'}</Text>
      <Text fontSize="$3">{meeting.outcome}</Text>
      <Text fontSize="$2" color="$colorPress">
        {new Date(meeting.logged_at).toLocaleString()}
      </Text>
    </YStack>
  );
}

export default function MeetingsScreen() {
  const { meetings, loading, refresh } = useMeetings();

  return (
    <YStack flex={1} backgroundColor="$background">
      <XStack padding="$4" justifyContent="flex-end">
        <Link href="/(tabs)/meetings/record" asChild>
          <Button size="$3" theme="active">+ Record Meeting</Button>
        </Link>
      </XStack>

      {loading && !meetings.length ? (
        <YStack flex={1} justifyContent="center" alignItems="center">
          <Spinner size="large" />
        </YStack>
      ) : (
        <FlatList
          data={meetings}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <MeetingRow meeting={item} />}
          ItemSeparatorComponent={() => <Separator />}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} />}
          ListEmptyComponent={
            <YStack flex={1} justifyContent="center" alignItems="center" padding="$8">
              <Text color="$colorPress">No meetings recorded yet.</Text>
            </YStack>
          }
        />
      )}
    </YStack>
  );
}
```

#### `app/(tabs)/meetings/record.tsx`

```typescript
import { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, Image } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import { Button, Checkbox, Label, Separator, Spinner, Text, XStack, YStack } from 'tamagui';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../lib/useAuth';
import { MEETING_AGENDAS, MEETING_OUTCOMES } from '../../../types';

export default function RecordMeetingScreen() {
  const { clientId } = useLocalSearchParams<{ clientId?: string }>();
  const { session } = useAuth();

  const [selectedAgendas, setSelectedAgendas] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<string>(MEETING_OUTCOMES[0]);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [loadingLocation, setLoadingLocation] = useState(false);
  const [saving, setSaving] = useState(false);

  // Auto-capture GPS on mount
  useEffect(() => {
    captureLocation();
  }, []);

  async function captureLocation() {
    setLoadingLocation(true);
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission denied', 'Location permission is required to record a meeting.');
      setLoadingLocation(false);
      return;
    }
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    setLoadingLocation(false);
  }

  async function captureSelfie() {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission denied', 'Camera permission is required for selfie capture.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
      allowsEditing: false,
    });
    if (!result.canceled && result.assets.length > 0) {
      setPhotoUri(result.assets[0].uri);
    }
  }

  function toggleAgenda(agenda: string) {
    setSelectedAgendas((prev) =>
      prev.includes(agenda) ? prev.filter((a) => a !== agenda) : [...prev, agenda]
    );
  }

  async function handleSave() {
    if (!location) {
      Alert.alert('GPS Required', 'Wait for GPS location to be captured before saving.');
      return;
    }
    if (!photoUri) {
      Alert.alert('Selfie Required', 'Please capture a selfie before saving.');
      return;
    }

    setSaving(true);

    // Upload photo to Supabase Storage
    let photoUrl: string | null = null;
    try {
      const ext = photoUri.split('.').pop() ?? 'jpg';
      const fileName = `meetings/${session?.user.id}/${Date.now()}.${ext}`;
      const response = await fetch(photoUri);
      const blob = await response.blob();
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('meeting-photos')
        .upload(fileName, blob, { contentType: `image/${ext}` });
      if (uploadError) throw uploadError;
      const { data: publicUrlData } = supabase.storage
        .from('meeting-photos')
        .getPublicUrl(fileName);
      photoUrl = publicUrlData.publicUrl;
    } catch (err: any) {
      Alert.alert('Upload Error', err.message ?? 'Failed to upload photo.');
      setSaving(false);
      return;
    }

    const { error } = await supabase.from('meetings').insert({
      client_id: clientId ?? null,
      agent_id: session?.user.id,
      gps_lat: location.lat,
      gps_lng: location.lng,
      selfie_url: photoUrl,
      agendas: selectedAgendas,
      outcome,
      logged_at: new Date().toISOString(),
    });

    setSaving(false);
    if (error) {
      Alert.alert('Error', error.message);
    } else {
      router.back();
    }
  }

  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
      <YStack flex={1} padding="$6" gap="$5" backgroundColor="$background">
        <Text fontSize="$6" fontWeight="700">Record Meeting</Text>

        {/* GPS */}
        <YStack gap="$2">
          <Label>GPS Location</Label>
          {loadingLocation ? (
            <XStack gap="$2" alignItems="center">
              <Spinner size="small" />
              <Text color="$colorPress">Capturing location…</Text>
            </XStack>
          ) : location ? (
            <Text fontSize="$3" color="$colorPress">
              {location.lat.toFixed(6)}, {location.lng.toFixed(6)}
            </Text>
          ) : (
            <Button size="$3" onPress={captureLocation}>Retry GPS</Button>
          )}
        </YStack>

        <Separator />

        {/* Selfie */}
        <YStack gap="$2">
          <Label>Selfie Photo *</Label>
          {photoUri ? (
            <YStack gap="$2">
              <Image
                source={{ uri: photoUri }}
                style={{ width: '100%', height: 200, borderRadius: 8 }}
                resizeMode="cover"
              />
              <Button size="$3" onPress={captureSelfie}>Retake</Button>
            </YStack>
          ) : (
            <Button size="$3" onPress={captureSelfie}>Open Camera</Button>
          )}
        </YStack>

        <Separator />

        {/* Agenda */}
        <YStack gap="$2">
          <Label>Agenda (select all that apply)</Label>
          {MEETING_AGENDAS.map((agenda) => (
            <XStack key={agenda} gap="$3" alignItems="center">
              <Checkbox
                id={agenda}
                size="$4"
                checked={selectedAgendas.includes(agenda)}
                onCheckedChange={() => toggleAgenda(agenda)}
              >
                <Checkbox.Indicator>
                  <Text>✓</Text>
                </Checkbox.Indicator>
              </Checkbox>
              <Label htmlFor={agenda}>{agenda}</Label>
            </XStack>
          ))}
        </YStack>

        <Separator />

        {/* Outcome */}
        <YStack gap="$2">
          <Label>Meeting Outcome</Label>
          {MEETING_OUTCOMES.map((o) => (
            <Button
              key={o}
              size="$3"
              theme={outcome === o ? 'active' : undefined}
              onPress={() => setOutcome(o)}
            >
              {o}
            </Button>
          ))}
        </YStack>

        <Button
          size="$4"
          marginTop="$4"
          onPress={handleSave}
          disabled={saving}
          theme="active"
          icon={saving ? <Spinner /> : undefined}
        >
          {saving ? 'Saving…' : 'Save Meeting'}
        </Button>
      </YStack>
    </ScrollView>
  );
}
```

### `lib/`

#### `lib/supabase.ts`

```typescript
import { createClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import type { Database } from '../types/database';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Custom storage adapter using expo-secure-store so Supabase auth tokens
 * are persisted securely on the device (not in AsyncStorage/plain text).
 */
const ExpoSecureStoreAdapter = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: ExpoSecureStoreAdapter,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
```

#### `lib/useAuth.ts`

```typescript
import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  function signOut() {
    return supabase.auth.signOut();
  }

  return { session, loading, signOut };
}
```

#### `lib/useClients.ts`

```typescript
import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import type { Client } from '../types';

export function useClients() {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('clients')
      .select('*')
      .order('created_at', { ascending: false });
    if (!error && data) setClients(data as Client[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { clients, loading, refresh: fetch };
}
```

#### `lib/useMeetings.ts`

```typescript
import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import type { Meeting } from '../types';

export function useMeetings(clientId?: string) {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    setLoading(true);
    let query = supabase
      .from('meetings')
      .select(`
        *,
        clients ( company_name )
      `)
      .order('logged_at', { ascending: false });

    if (clientId) {
      query = query.eq('client_id', clientId);
    }

    const { data, error } = await query;
    if (!error && data) {
      setMeetings(
        data.map((m: any) => ({
          ...m,
          client_name: m.clients?.company_name ?? null,
        })) as Meeting[]
      );
    }
    setLoading(false);
  }, [clientId]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { meetings, loading, refresh: fetch };
}
```

### `types/`

#### `types/database.ts`

```typescript
/**
 * Supabase database type stubs.
 * Replace with the generated types from: npx supabase gen types typescript --project-id <your-id>
 */
export type Database = {
  public: {
    Tables: {
      clients: {
        Row: {
          id: string;
          company_name: string;
          contact_person: string;
          customer_type: string;
          sales_channel: string;
          agent_id: string;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['clients']['Row'], 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Database['public']['Tables']['clients']['Insert']>;
      };
      meetings: {
        Row: {
          id: string;
          client_id: string | null;
          agent_id: string;
          gps_lat: number;
          gps_lng: number;
          selfie_url: string;
          agendas: string[];
          outcome: string;
          logged_at: string;
          created_at: string;
        };
        Insert: Omit<Database['public']['Tables']['meetings']['Row'], 'id' | 'created_at'>;
        Update: Partial<Database['public']['Tables']['meetings']['Insert']>;
      };
      profiles: {
        Row: {
          id: string;
          email: string;
          full_name: string;
          role: string;
          team_id: string | null;
        };
        Insert: Omit<Database['public']['Tables']['profiles']['Row'], 'id'>;
        Update: Partial<Database['public']['Tables']['profiles']['Insert']>;
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
};
```

#### `types/index.ts`

```typescript
// ─── Domain constants ──────────────────────────────────────────────────────────

export const CUSTOMER_TYPES = [
  'Dealer',
  'Sub-Dealer',
  'Direct Account',
  'Government',
  'End-User',
] as const;

export const SALES_CHANNELS = [
  'Direct Sales',
  'Dealer Network',
  'Online',
  'Referral',
  'Other',
] as const;

export const MEETING_AGENDAS = [
  'Product Presentation',
  'Pricing Negotiation',
  'Follow-up',
  'Contract Signing',
  'After-Sales Support',
  'New Requirements',
  'Other',
] as const;

export const MEETING_OUTCOMES = [
  'Successful',
  'Follow-up Required',
  'No Decision',
  'Lost Opportunity',
] as const;

// ─── TypeScript types ──────────────────────────────────────────────────────────

export type CustomerType = typeof CUSTOMER_TYPES[number];
export type SalesChannel = typeof SALES_CHANNELS[number];
export type MeetingOutcome = typeof MEETING_OUTCOMES[number];

export interface Client {
  id: string;
  company_name: string;
  contact_person: string;
  customer_type: CustomerType;
  sales_channel: SalesChannel;
  agent_id: string;
  created_at: string;
  updated_at: string;
}

export interface Meeting {
  id: string;
  client_id: string | null;
  client_name?: string | null;
  agent_id: string;
  gps_lat: number;
  gps_lng: number;
  selfie_url: string;
  agendas: string[];
  outcome: MeetingOutcome;
  logged_at: string;
  created_at: string;
}

export type UserRole = 'sales_specialist' | 'sales_manager' | 'admin';

export interface UserProfile {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  team_id: string | null;
}
```
