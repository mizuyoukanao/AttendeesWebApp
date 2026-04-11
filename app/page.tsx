"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Html5QrcodeScanner } from "html5-qrcode";
import clsx from "clsx";
import Papa from "papaparse";

type AdjustmentOption = {
  key: string;
  label: string;
  deltaAmount: number;
  requiresReason: boolean;
};

type PricingConfig = {
  generalFee: number;
  bringConsoleFee: number;
  studentFixedFee: number;
  adjustmentOptions: AdjustmentOption[];
};

const defaultPricingConfig: PricingConfig = {
  generalFee: 4000,
  bringConsoleFee: 3000,
  studentFixedFee: 1000,
  adjustmentOptions: [
    { key: "none", label: "変更なし", deltaAmount: 0, requiresReason: false },
    { key: "general_to_bring", label: "一般→持参 (-1000円)", deltaAmount: -1000, requiresReason: false },
    { key: "bring_to_general", label: "持参→一般 (+1000円)", deltaAmount: 1000, requiresReason: false },
    { key: "student_general", label: "学割（一般）(-3000円)", deltaAmount: -3000, requiresReason: false },
    { key: "student_bring", label: "学割（持参）(-2000円)", deltaAmount: -2000, requiresReason: false },
    { key: "other", label: "その他（理由と金額を入力）", deltaAmount: 0, requiresReason: true },
  ],
};

const initialParticipants: Participant[] = [
  {
    participantId: "101",
    playerName: "Skyline",
    adminNotes: "A-01",
    venueFeeName: "優先持参枠",
    payment: { totalTransaction: 4000, totalOwed: 0, totalPaid: 4000 },
    checkedIn: false,
    seatLabel: "",
  },
  {
    participantId: "102",
    playerName: "Luna",
    adminNotes: "B-02",
    venueFeeName: "持参枠",
    payment: { totalTransaction: 0, totalOwed: 4000, totalPaid: 0 },
    checkedIn: false,
    seatLabel: "",
  },
  {
    participantId: "103",
    playerName: "Comet",
    adminNotes: "C-03",
    venueFeeName: "一般枠",
    payment: { totalTransaction: 0, totalOwed: 3000, totalPaid: 0 },
    checkedIn: true,
    checkedInAt: new Date().toISOString(),
    seatLabel: "C-03",
  },
];

type Payment = {
  totalTransaction: number;
  totalOwed: number;
  totalPaid?: number;
};

type Participant = {
  participantId: string;
  playerName: string;
  adminNotes?: string;
  venueFeeName?: string;
  payment: Payment;
  checkedIn: boolean;
  checkedInAt?: string;
  checkedInBy?: string;
  seatLabel?: string;
};

type AuthSession = {
  authenticated: boolean;
  user?: {
    id?: string;
    name?: string;
  };
  session?: {
    mode?: "startgg" | "operator_code";
    allowedTournamentIds?: string[];
  };
};

type AccessCodeRecord = {
  codeHash: string;
  maskedCode?: string;
  status: "active" | "disabled" | "deleted";
  createdAt: string;
  updatedAt: string;
};

type ManagedTournament = {
  id: string;
  name: string;
  slug?: string;
  startAt?: number;
  city?: string;
  addrState?: string;
  countryCode?: string;
};

const TOURNAMENT_CACHE_KEY = "known_tournaments";

type PaymentStatus = {
  status: "prepaid" | "due" | "refund";
  amount: number;
  label: string;
};

type SeatPatternConfig = {
  venueFeeNames: string[];
  pattern: string;
  exceptionPlayerNames: string[];
  reserveLabelPrefix: string;
};

type SeatAssignmentConfig = {
  bulk: SeatPatternConfig;
  autoOnCheckin: SeatPatternConfig & { enabled: boolean };
};

const defaultSeatPatternConfig: SeatPatternConfig = {
  venueFeeNames: [],
  pattern: "{Alphabet:A:D}-{Int:1:4}",
  exceptionPlayerNames: [],
  reserveLabelPrefix: "予備台",
};

const defaultSeatAssignmentConfig: SeatAssignmentConfig = {
  bulk: defaultSeatPatternConfig,
  autoOnCheckin: {
    ...defaultSeatPatternConfig,
    enabled: false,
  },
};

function parseParticipantIdFromQr(raw: string) {
  const trimmed = raw.trim();
  const urlMatch = trimmed.match(/participant\/(\d+)\/qr/);
  if (urlMatch?.[1]) return urlMatch[1];
  const digitsOnly = trimmed.match(/^\d+$/);
  return digitsOnly ? digitsOnly[0] : null;
}

function computePaymentStatus(
  participant: Participant,
  studentDiscount: boolean,
  adjustment: AdjustmentOption,
  customDelta: number,
  pricing: PricingConfig,
): PaymentStatus {
  const baseDue = participant.payment.totalTransaction !== 0 ? 0 : participant.payment.totalOwed;
  const studentDue = studentDiscount ? pricing.studentFixedFee : baseDue;
  const delta = adjustment.key === "other" ? customDelta : adjustment.deltaAmount;
  const amount = studentDue + delta;
  if (amount > 0) {
    return { status: "due", amount, label: `${amount.toLocaleString()}円 支払` };
  }
  if (amount < 0) {
    return { status: "refund", amount: Math.abs(amount), label: `${Math.abs(amount).toLocaleString()}円 返金` };
  }
  return { status: "prepaid", amount: 0, label: "支払い不要" };
}

function getDisplayName(participant: Participant) {
  return participant.playerName || participant.participantId;
}

function formatTimestampJst(date: Date) {
  const offsetMs = 9 * 60 * 60 * 1000;
  const local = new Date(date.getTime() + offsetMs);
  const yyyy = local.getUTCFullYear();
  const mm = `${local.getUTCMonth() + 1}`.padStart(2, "0");
  const dd = `${local.getUTCDate()}`.padStart(2, "0");
  const hh = `${local.getUTCHours()}`.padStart(2, "0");
  const min = `${local.getUTCMinutes()}`.padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min} JST`;
}

function describeTournament(t: ManagedTournament) {
  const location = [t.city, t.addrState, t.countryCode].filter(Boolean).join(" / ");
  const startDate = t.startAt ? new Date(t.startAt * 1000).toLocaleDateString("ja-JP") : "";
  const name = t.name || t.slug || t.id;
  const suffix = [startDate, location].filter(Boolean).join(" | ");
  return suffix ? `${name} (${suffix})` : name;
}

function normalizeTournamentCache(input: unknown): ManagedTournament[] {
  if (!Array.isArray(input)) return [];
  const normalized = input
    .map((item: any) => ({
      id: String(item?.id || "").trim(),
      name: String(item?.name || "").trim(),
    }))
    .filter((item) => item.id);
  return Array.from(new Map(normalized.map((item) => [item.id, item])).values());
}

function expandAlphabetRange(start: string, end: string): string[] {
  if (!start || !end) return [];
  const startCode = start.toUpperCase().charCodeAt(0);
  const endCode = end.toUpperCase().charCodeAt(0);
  const step = startCode <= endCode ? 1 : -1;
  const result: string[] = [];
  for (let code = startCode; step > 0 ? code <= endCode : code >= endCode; code += step) {
    result.push(String.fromCharCode(code));
  }
  return result;
}

function expandIntRange(start: number, end: number): string[] {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  const step = start <= end ? 1 : -1;
  const result: string[] = [];
  for (let value = start; step > 0 ? value <= end : value >= end; value += step) {
    result.push(String(value));
  }
  return result;
}

function buildSeatLabels(pattern: string, totalCount: number): string[] {
  const tokenRegex = /\{(Alphabet|Int):([^{}:]+):([^{}:]+)\}|\{Count\}/g;
  const segments: Array<{ kind: "text"; value: string } | { kind: "values"; values: string[] }> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(pattern)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: "text", value: pattern.slice(lastIndex, match.index) });
    }
    if (match[0] === "{Count}") {
      segments.push({ kind: "text", value: String(totalCount) });
    } else {
      const type = match[1];
      const rangeStart = match[2]?.trim() || "";
      const rangeEnd = match[3]?.trim() || "";
      const values = type === "Alphabet"
        ? expandAlphabetRange(rangeStart, rangeEnd)
        : expandIntRange(Number(rangeStart), Number(rangeEnd));
      segments.push({ kind: "values", values });
    }
    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < pattern.length) {
    segments.push({ kind: "text", value: pattern.slice(lastIndex) });
  }

  return segments.reduce<string[]>((acc, segment) => {
    if (segment.kind === "text") return acc.map((prefix) => `${prefix}${segment.value}`);
    if (!segment.values.length) return [];
    return acc.flatMap((prefix) => segment.values.map((value) => `${prefix}${value}`));
  }, [""]);
}

export default function HomePage() {
  const [activeTab, setActiveTab] = useState<"kiosk" | "operator" | "dashboard" | "lostFound">("kiosk");
  const [tournamentId, setTournamentId] = useState("demo-tournament");
  const [pricingConfig, setPricingConfig] = useState<PricingConfig>(defaultPricingConfig);
  const [pricingMessage, setPricingMessage] = useState("");
  const [pricingSource, setPricingSource] = useState<string>("default");
  const [pricingName, setPricingName] = useState("");
  const [pricingSaving, setPricingSaving] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>(initialParticipants);
  const [firestoreReady, setFirestoreReady] = useState(false);
  const [firestoreError, setFirestoreError] = useState("");
  const [scanResult, setScanResult] = useState<Participant | null>(null);
  const [scanRaw, setScanRaw] = useState("");
  const [scannerError, setScannerError] = useState("");
  const [studentDiscount, setStudentDiscount] = useState(false);
  const [selectedAdjustment, setSelectedAdjustment] = useState(defaultPricingConfig.adjustmentOptions[0].key);
  const [customReason, setCustomReason] = useState("");
  const [customAmount, setCustomAmount] = useState(0);
  const [operatorMessage, setOperatorMessage] = useState("");
  const [isCsvUploading, setIsCsvUploading] = useState(false);
  const [kioskMessage, setKioskMessage] = useState<ReactNode>("");
  const [lostFoundRaw, setLostFoundRaw] = useState("");
  const [lostFoundResult, setLostFoundResult] = useState<Participant | null>(null);
  const [lostFoundError, setLostFoundError] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [filter, setFilter] = useState<"all" | "checkedIn" | "notCheckedIn">("all");
  const [venueFeeFilter, setVenueFeeFilter] = useState("all");
  const [sortOrder, setSortOrder] = useState<"idAsc" | "idDesc" | "nameAsc" | "nameDesc">("idAsc");
  const [seatAssignmentConfig, setSeatAssignmentConfig] = useState<SeatAssignmentConfig>(defaultSeatAssignmentConfig);
  const [assignmentMessage, setAssignmentMessage] = useState("");
  const [assignmentSaving, setAssignmentSaving] = useState(false);
  const [overwriteSeatAssignment, setOverwriteSeatAssignment] = useState(false);
  const [editingParticipant, setEditingParticipant] = useState<Participant | null>(null);
  const [editAdminNotes, setEditAdminNotes] = useState("");
  const [editAdjustmentKey, setEditAdjustmentKey] = useState(defaultPricingConfig.adjustmentOptions[0].key);
  const [editCustomReason, setEditCustomReason] = useState("");
  const [editCustomAmount, setEditCustomAmount] = useState(0);
  const [editCheckedIn, setEditCheckedIn] = useState(false);
  const scannerContainerRef = useRef<HTMLDivElement>(null);
  const lostFoundScannerContainerRef = useRef<HTMLDivElement>(null);
  const [authSession, setAuthSession] = useState<AuthSession>({ authenticated: false });
  const [accessCodeInput, setAccessCodeInput] = useState("");
  const [accessHandleInput, setAccessHandleInput] = useState("");
  const [accessOverlayOpen, setAccessOverlayOpen] = useState(true);
  const [accessMessage, setAccessMessage] = useState("");
  const [pendingDeepLinkCode, setPendingDeepLinkCode] = useState("");
  const [issuingAccessCode, setIssuingAccessCode] = useState(false);
  const [issuedAccessCode, setIssuedAccessCode] = useState("");
  const [accessCodeHistory, setAccessCodeHistory] = useState<AccessCodeRecord[]>([]);
  const [accessCodeAdminMessage, setAccessCodeAdminMessage] = useState("");
  const [authError, setAuthError] = useState("");
  const [managedTournaments, setManagedTournaments] = useState<ManagedTournament[]>([]);
  const [tournamentLoading, setTournamentLoading] = useState(false);
  const [tournamentMessage, setTournamentMessage] = useState("");
  const [tournamentError, setTournamentError] = useState("");
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const compactKiosk = isMobileViewport;
  const hasOperatorAccess = Boolean(authSession.authenticated);
  const activeAccessCode = issuedAccessCode;
  const shareUrl = typeof window !== "undefined" && activeAccessCode
    ? `${window.location.origin}${window.location.pathname}?tournamentId=${encodeURIComponent(tournamentId)}&code=${encodeURIComponent(activeAccessCode)}`
    : "";
  const shareQrUrl = shareUrl
    ? `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(shareUrl)}`
    : "";

  const adjustmentOption = useMemo(
    () => {
      const options = adjustmentOptions();
      return options.find((opt) => opt.key === selectedAdjustment) ?? options[0];
    },
    [selectedAdjustment, pricingConfig],
  );
  const editAdjustmentOption = useMemo(() => {
    const options = adjustmentOptions();
    return options.find((opt) => opt.key === editAdjustmentKey) ?? options[0];
  }, [editAdjustmentKey, pricingConfig]);

  useEffect(() => {
    if (activeTab !== "kiosk" || !hasOperatorAccess) {
      return undefined;
    }
    if (!scannerContainerRef.current) {
      return undefined;
    }
    const elementId = scannerContainerRef.current.id || "qr-reader";
    scannerContainerRef.current.id = elementId;

    const scanner = new Html5QrcodeScanner(elementId, { fps: 10, qrbox: 240 }, false);
    scanner.render(
      (decoded) => {
        setScannerError("");
        setScanRaw(decoded);
        handleLookup(decoded);
      },
      (error) => {
        setScannerError(error);
      },
    );

    return () => {
      scanner.clear().catch(() => {});
    };
  }, [activeTab, hasOperatorAccess, tournamentId]);

  useEffect(() => {
    if (activeTab !== "lostFound" || !hasOperatorAccess) {
      return undefined;
    }
    if (!lostFoundScannerContainerRef.current) {
      return undefined;
    }
    const elementId = lostFoundScannerContainerRef.current.id || "lost-found-qr-reader";
    lostFoundScannerContainerRef.current.id = elementId;

    const scanner = new Html5QrcodeScanner(elementId, { fps: 10, qrbox: 240 }, false);
    scanner.render(
      (decoded) => {
        setLostFoundRaw(decoded);
        handleLostFoundLookup(decoded);
      },
      () => undefined,
    );

    return () => {
      scanner.clear().catch(() => {});
    };
  }, [activeTab, hasOperatorAccess, tournamentId, participants]);

  useEffect(() => {
    refreshSession();
  }, []);

  useEffect(() => {
    try {
      const cached = window.localStorage.getItem(TOURNAMENT_CACHE_KEY);
      if (!cached) return;
      const parsed = normalizeTournamentCache(JSON.parse(cached));
      if (parsed.length > 0) {
        setManagedTournaments(parsed);
      }
    } catch {
      // ignore storage parse errors
    }
  }, []);

  useEffect(() => {
    try {
      if (!managedTournaments.length) {
        window.localStorage.removeItem(TOURNAMENT_CACHE_KEY);
        return;
      }
      const minimal = managedTournaments.map((item) => ({ id: item.id, name: item.name || "" }));
      window.localStorage.setItem(TOURNAMENT_CACHE_KEY, JSON.stringify(minimal));
    } catch {
      // ignore storage write errors
    }
  }, [managedTournaments]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const queryTournamentId = params.get("tournamentId");
    const queryCode = params.get("code");
    if (queryTournamentId) {
      setTournamentId(queryTournamentId);
    }
    if (queryCode) {
      setAccessCodeInput(queryCode);
      setPendingDeepLinkCode(queryCode);
    }
  }, []);

  useEffect(() => {
    if (!pendingDeepLinkCode) return;
    verifyTournamentAccessCode(pendingDeepLinkCode, true).finally(() => {
      setPendingDeepLinkCode("");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDeepLinkCode]);

  useEffect(() => {
    setAccessOverlayOpen(!hasOperatorAccess);
  }, [hasOperatorAccess]);

  useEffect(() => {
    if (authSession.authenticated) {
      fetchManagedTournaments();
      loadAccessCodeHistory();
    } else {
      setTournamentMessage("");
      setTournamentError("");
      setAccessCodeHistory([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authSession.authenticated]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 768px), (pointer: coarse)");
    const sync = () => {
      const isMobile = media.matches;
      setIsMobileViewport(isMobile);
    };
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!tournamentId || !hasOperatorAccess) return;
    loadPricingConfig(tournamentId);
    if (authSession.authenticated) {
      loadSeatAssignmentConfig(tournamentId);
      loadAccessCodeHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tournamentId, authSession.authenticated, hasOperatorAccess]);

  async function fetchParticipantsSnapshot(targetTournamentId: string) {
    const res = await fetch(`/api/tournaments/${encodeURIComponent(targetTournamentId)}/participants`, {
      credentials: "include",
      cache: "no-store",
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || res.statusText);
    const next = Array.isArray(data?.participants) ? data.participants : [];
    setParticipants(next as Participant[]);
    setFirestoreReady(true);
  }

  useEffect(() => {
    setFirestoreError("");
    setFirestoreReady(false);

    if (!tournamentId || !hasOperatorAccess) {
      setParticipants([]);
      return () => undefined;
    }

    let closed = false;
    const streamUrl = `/api/tournaments/${encodeURIComponent(tournamentId)}/participants/stream`;
    const source = new EventSource(streamUrl, { withCredentials: true });

    const applyPayload = (payload: any) => {
      const next = Array.isArray(payload?.participants) ? payload.participants : [];
      setParticipants(next as Participant[]);
      setFirestoreReady(true);
      setFirestoreError("");
    };

    const snapshotEventHandler = (event: MessageEvent) => {
      try {
        applyPayload(JSON.parse(event.data));
      } catch {
        setFirestoreError("参加者データの受信に失敗しました");
      }
    };

    const onUpdateEvent = (event: MessageEvent) => {
      try {
        applyPayload(JSON.parse(event.data));
      } catch {
        setFirestoreError("参加者更新の反映に失敗しました");
      }
    };

    source.addEventListener("snapshot", snapshotEventHandler);
    source.addEventListener("update", onUpdateEvent);

    source.onerror = async () => {
      if (closed) return;
      setFirestoreError("リアルタイム接続が不安定です。通常取得にフォールバックします。");
      try {
        await fetchParticipantsSnapshot(tournamentId);
      } catch (error: any) {
        if (!closed) {
          setFirestoreError(`参加者取得に失敗しました: ${error?.message || "unknown"}`);
        }
      }
    };

    return () => {
      closed = true;
      source.removeEventListener("snapshot", snapshotEventHandler);
      source.removeEventListener("update", onUpdateEvent);
      source.close();
    };
  }, [tournamentId, hasOperatorAccess]);

  useEffect(() => {
    const exists = pricingConfig.adjustmentOptions.some((opt) => opt.key === selectedAdjustment);
    if (!exists && pricingConfig.adjustmentOptions[0]) {
      setSelectedAdjustment(pricingConfig.adjustmentOptions[0].key);
    }
  }, [pricingConfig, selectedAdjustment]);

  function adjustmentOptions(): AdjustmentOption[] {
    return pricingConfig.adjustmentOptions;
  }

  async function loadPricingConfig(targetId: string) {
    setPricingMessage(`料金設定(${targetId})を取得中...`);
    try {
      const res = await fetch(`/api/tournaments/${encodeURIComponent(targetId)}/pricing`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || res.statusText);
      const config = (data.pricingConfig as PricingConfig) || defaultPricingConfig;
      setPricingConfig(config);
      setPricingSource(data.source || "firestore");
      setPricingName(data.name || "");
      setSelectedAdjustment((config.adjustmentOptions[0]?.key) || "none");
      setPricingMessage(`料金設定を読み込みました`);
    } catch (error: any) {
      setPricingConfig(defaultPricingConfig);
      setPricingSource("default");
      setPricingMessage(`料金設定の取得に失敗しました: ${error?.message || "unknown"}`);
    }
  }

  async function loadSeatAssignmentConfig(targetId: string) {
    if (!targetId) return;
    try {
      const res = await fetch(`/api/tournaments/${encodeURIComponent(targetId)}/seat-assignment`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || res.statusText);
      const config = (data.seatAssignmentConfig as SeatAssignmentConfig) || defaultSeatAssignmentConfig;
      setSeatAssignmentConfig({
        bulk: {
          ...defaultSeatPatternConfig,
          ...(config.bulk || {}),
        },
        autoOnCheckin: {
          ...defaultSeatPatternConfig,
          ...(config.autoOnCheckin || {}),
          enabled: Boolean(config?.autoOnCheckin?.enabled),
        },
      });
    } catch (error: any) {
      setAssignmentMessage(`台番号設定の取得に失敗しました: ${error?.message || "unknown"}`);
    }
  }

  async function saveSeatAssignmentConfig() {
    if (!authSession.authenticated) {
      setAssignmentMessage("設定保存にはstart.ggログインが必要です");
      return;
    }
    if (!tournamentId) {
      setAssignmentMessage("対象大会を選択してください");
      return;
    }
    setAssignmentSaving(true);
    setAssignmentMessage("台番号設定を保存しています...");
    try {
      const res = await fetch(`/api/tournaments/${encodeURIComponent(tournamentId)}/seat-assignment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seatAssignmentConfig }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || res.statusText);
      setAssignmentMessage("台番号設定を保存しました");
    } catch (error: any) {
      setAssignmentMessage(`台番号設定の保存に失敗しました: ${error?.message || "unknown"}`);
    } finally {
      setAssignmentSaving(false);
    }
  }

  async function savePricingConfig() {
    setPricingSaving(true);
    setPricingMessage("料金設定を保存しています...");
    try {
      const res = await fetch(`/api/tournaments/${encodeURIComponent(tournamentId)}/pricing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pricingConfig, name: pricingName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || res.statusText);
      setPricingConfig(data.pricingConfig as PricingConfig);
      setPricingSource("firestore");
      setPricingMessage("料金設定をデータベースに保存しました");
    } catch (error: any) {
      setPricingMessage(`保存に失敗しました: ${error?.message || "unknown"}`);
    } finally {
      setPricingSaving(false);
    }
  }

  function updatePricingField(key: keyof PricingConfig, value: number) {
    setPricingConfig((prev) => ({ ...prev, [key]: value }));
  }

  function updateAdjustment(index: number, key: keyof AdjustmentOption, value: string | number | boolean) {
    setPricingConfig((prev) => {
      const next = [...prev.adjustmentOptions];
      const target = next[index];
      if (!target) return prev;
      next[index] = { ...target, [key]: value } as AdjustmentOption;
      return { ...prev, adjustmentOptions: next };
    });
  }

  function addAdjustment() {
    setPricingConfig((prev) => ({
      ...prev,
      adjustmentOptions: [
        ...prev.adjustmentOptions,
        {
          key: `custom_${prev.adjustmentOptions.length + 1}`,
          label: "新規オプション",
          deltaAmount: 0,
          requiresReason: false,
        },
      ],
    }));
  }

  function removeAdjustment(index: number) {
    setPricingConfig((prev) => {
      if (prev.adjustmentOptions.length <= 1) return prev;
      const next = prev.adjustmentOptions.filter((_, i) => i !== index);
      return { ...prev, adjustmentOptions: next };
    });
  }

  async function refreshSession() {
    try {
      const res = await fetch("/api/auth/session", { credentials: "include", cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAuthSession({ authenticated: false });
        setAuthError(data?.error ? `認証エラー: ${data.error}` : "未認証です");
        return;
      }
      setAuthSession(data as AuthSession);
      setAuthError("");
    } catch (error: any) {
      setAuthSession({ authenticated: false });
      setAuthError("認証状態の取得に失敗しました: " + (error?.message ?? ""));
    }
  }


  async function verifyTournamentAccessCode(codeOverride?: string, fromDeepLink = false) {
    const code = (codeOverride ?? accessCodeInput).trim();
    if (!code) {
      setAccessMessage("大会コードを入力してください");
      return;
    }
    setAccessMessage(fromDeepLink ? "リンク内のコードを確認しています..." : "コードを確認しています...");
    try {
      const res = await fetch("/api/operator/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          handleName: accessHandleInput.trim() || "code-operator",
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.tournamentId) {
        throw new Error(data?.error || "コードが無効です");
      }
      const resolvedTournamentId = String(data.tournamentId || "").trim();
      if (!resolvedTournamentId) {
        throw new Error("大会IDの解決に失敗しました");
      }
      setTournamentId(resolvedTournamentId);
      setManagedTournaments((prev) => (
        prev.some((item) => item.id === resolvedTournamentId) ? prev : [...prev, { id: resolvedTournamentId, name: resolvedTournamentId }]
      ));
      await refreshSession();
      setAccessCodeInput("");
      setAccessMessage("");
      setAccessOverlayOpen(false);
    } catch (error: any) {
      if (fromDeepLink) {
        setAccessOverlayOpen(true);
        setAccessMessage(`リンク内コードの認証に失敗しました: ${error?.message || "不明なエラー"}`);
      } else {
        setAccessMessage(error?.message || "コード認証に失敗しました");
      }
    }
  }

  async function issueTournamentAccessCode() {
    if (!authSession.authenticated) {
      setAccessMessage("コード発行にはstart.ggログインが必要です");
      return;
    }
    if (!tournamentId) {
      setAccessMessage("大会を選択してください");
      return;
    }
    setIssuingAccessCode(true);
    try {
      const selectedTournament = managedTournaments.find((item) => item.id === tournamentId);
      const tournamentName = (selectedTournament?.name || pricingName || "").trim();
      const res = await fetch(`/api/tournaments/${encodeURIComponent(tournamentId)}/access-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: tournamentName || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || res.statusText);
      setIssuedAccessCode(String(data.accessCode || ""));
      setAccessMessage("大会コードを発行しました");
      await loadAccessCodeHistory();
    } catch (error: any) {
      setAccessMessage(error?.message || "コード発行に失敗しました");
    } finally {
      setIssuingAccessCode(false);
    }
  }

  async function loadAccessCodeHistory() {
    if (!authSession.authenticated || !tournamentId) return;
    try {
      const res = await fetch(`/api/tournaments/${encodeURIComponent(tournamentId)}/access-code`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || res.statusText);
      setAccessCodeHistory(Array.isArray(data.history) ? data.history : []);
    } catch (error: any) {
      setAccessCodeAdminMessage(error?.message || "大会コード履歴の取得に失敗しました");
    }
  }

  async function updateAccessCodeStatus(codeHash: string, action: "disable" | "delete" | "activate") {
    if (!authSession.authenticated || !tournamentId) return;
    try {
      const res = await fetch(`/api/tournaments/${encodeURIComponent(tournamentId)}/access-code`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codeHash, action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || res.statusText);
      setAccessCodeAdminMessage(`コードを${action === "disable" ? "無効化" : action === "delete" ? "削除" : "有効化"}しました`);
      await loadAccessCodeHistory();
    } catch (error: any) {
      setAccessCodeAdminMessage(error?.message || "大会コード更新に失敗しました");
    }
  }

  async function copyShareUrl() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setAccessCodeAdminMessage("共有用URLをクリップボードにコピーしました");
    } catch {
      setAccessCodeAdminMessage("クリップボードへのコピーに失敗しました");
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setAuthSession({ authenticated: false });
    setTournamentMessage("");
    setTournamentError("");
  }

  async function fetchManagedTournaments() {
    setTournamentLoading(true);
    setTournamentError("");
    setTournamentMessage("start.gg から大会を取得しています...");

    try {
      const res = await fetch("/api/startgg/tournaments");
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || res.statusText);

      const tournaments = normalizeTournamentCache((data.tournaments as ManagedTournament[]) || []);
      const preserved = tournamentId && !tournaments.some((item) => item.id === tournamentId)
        ? [{ id: tournamentId, name: pricingName || tournamentId }, ...tournaments]
        : tournaments;
      const merged = Array.from(new Map(preserved.map((item) => [item.id, item])).values());
      setManagedTournaments(merged);

      if (merged.length === 0) {
        setTournamentId("demo-tournament");
      } else if (!tournamentId || tournamentId === "demo-tournament") {
        setTournamentId(merged[0].id);
      }
      if (merged[0]?.name) {
        setPricingName((prev) => prev || merged[0].name || "");
      }

      setTournamentMessage(`${tournaments.length}件の大会を取得しました`);
    } catch (error: any) {
      setTournamentError(error?.message || "大会リストの取得に失敗しました");
      setTournamentMessage("");
    } finally {
      setTournamentLoading(false);
    }
  }

  function handleTournamentSelect(value: string) {
    clearCurrentParticipant();
    setKioskMessage("");
    setLostFoundRaw("");
    setLostFoundResult(null);
    setLostFoundError("");
    setTournamentId(value);
    const matched = managedTournaments.find((t) => t.id === value);
    if (matched?.name) {
      setPricingName((prev) => prev || matched.name || "");
    }
  }

  function handleLookup(raw: string) {
    const participantId = parseParticipantIdFromQr(raw);
    if (!participantId) {
      setScanResult(null);
      setScannerError("QRから参加者IDを取得できませんでした");
      return;
    }
    const participant = participants.find((p) => p.participantId === participantId) || null;
    setScanResult(participant);
    setScannerError(participant ? "" : "対象の参加者が見つかりません");
  }

  function handleManualLookup() {
    handleLookup(scanRaw.trim());
  }

  function handleLostFoundLookup(raw: string) {
    const participantId = parseParticipantIdFromQr(raw);
    if (!participantId) {
      setLostFoundResult(null);
      setLostFoundError("QRから参加者IDを取得できませんでした");
      return;
    }
    const participant = participants.find((p) => p.participantId === participantId) || null;
    setLostFoundResult(participant);
    setLostFoundError(participant ? "" : "対象の参加者が見つかりません");
  }

  function handleLostFoundManualLookup() {
    handleLostFoundLookup(lostFoundRaw.trim());
  }

  function clearCurrentParticipant() {
    setScanResult(null);
    setScanRaw("");
    setStudentDiscount(false);
    setSelectedAdjustment(pricingConfig.adjustmentOptions[0]?.key || "none");
    setCustomReason("");
    setCustomAmount(0);
    setEditingParticipant(null);
    setEditAdminNotes("");
    setEditAdjustmentKey(pricingConfig.adjustmentOptions[0]?.key || "none");
    setEditCustomReason("");
    setEditCustomAmount(0);
    setEditCheckedIn(false);
  }

  function openParticipantEditor(target: Participant) {
    setEditingParticipant(target);
    setEditAdminNotes(target.adminNotes || "");
    setEditAdjustmentKey(pricingConfig.adjustmentOptions[0]?.key || "none");
    setEditCustomReason("");
    setEditCustomAmount(0);
    setEditCheckedIn(target.checkedIn);
  }

  async function handleCheckIn() {
    if (!scanResult) return;
    if (scanResult.checkedIn) return;
    if (!hasOperatorAccess) {
      setKioskMessage("チェックインにはログインが必要です");
      return;
    }
    if (!tournamentId) {
      setScannerError("大会を選択してください");
      return;
    }

    const delta = adjustmentOption.key === "other" ? customAmount : adjustmentOption.deltaAmount;
    const reasonLabel = adjustmentOption.key === "other" ? `その他: ${customReason}` : adjustmentOption.label;

    try {
      const participantExists = participants.some((p) => p.participantId === scanResult.participantId);
      if (!participantExists) {
        throw new Error("選択中の大会に対象参加者が見つかりません。大会選択を確認してください。");
      }

      const res = await fetch(
        `/api/tournaments/${encodeURIComponent(tournamentId)}/participants/${encodeURIComponent(scanResult.participantId)}/checkin`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            deltaAmount: delta,
            reasonLabel,
            requestId: crypto.randomUUID(),
            requiresReason: Boolean(adjustmentOption?.requiresReason),
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || res.statusText);
      const autoSeatAssigned = Boolean(seatAssignmentConfig.autoOnCheckin.enabled && data?.assignedSeat);
      const seatSuffix = data?.assignedSeat ? `（対戦台: ${data.assignedSeat}）` : "";
      setOperatorMessage(`${getDisplayName(scanResult)} をチェックインしました${seatSuffix}`);
      if (autoSeatAssigned) {
        setKioskMessage(
          <>
            {getDisplayName(scanResult)} をチェックインしました（対戦台: <strong>{data.assignedSeat}</strong>）。次の参加者を読み取ってください。
          </>,
        );
      } else {
        setKioskMessage(`${getDisplayName(scanResult)} をチェックインしました${seatSuffix}。次の参加者を読み取ってください。`);
      }
      clearCurrentParticipant();
    } catch (error: any) {
      setOperatorMessage(`チェックインに失敗しました: ${error?.message || "unknown"}`);
      setKioskMessage(`チェックインに失敗しました: ${error?.message || "unknown"}`);
    }
  }

  async function updateParticipantStatus(target: Participant, resetCheckIn: boolean) {
    if (!tournamentId || !hasOperatorAccess) {
      const msg = !hasOperatorAccess
        ? "編集にはログインが必要です"
        : "対象大会を選択してください";
      setOperatorMessage(msg);
      setKioskMessage(msg);
      return;
    }
    const delta = editAdjustmentOption?.key === "other" ? editCustomAmount : (editAdjustmentOption?.deltaAmount ?? 0);
    const reasonLabel = editAdjustmentOption?.key === "other"
      ? `その他: ${editCustomReason || "編集"}`
      : (editAdjustmentOption?.label || "変更なし");

    try {
      const res = await fetch(
        `/api/tournaments/${encodeURIComponent(tournamentId)}/participants/${encodeURIComponent(target.participantId)}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            adminNotes: editAdminNotes,
            deltaAmount: delta,
            reasonLabel,
            requestId: crypto.randomUUID(),
            resetCheckIn,
            checkedIn: editCheckedIn,
            requiresReason: Boolean(editAdjustmentOption?.requiresReason),
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || res.statusText);
      const msg = resetCheckIn
        ? `${getDisplayName(target)} を未チェックインに戻しました`
        : `${getDisplayName(target)} の情報を更新しました`;
      setOperatorMessage(msg);
      setKioskMessage(msg);
      setEditingParticipant(null);
      setEditCustomReason("");
      setEditCustomAmount(0);
      if (scanResult?.participantId === target.participantId && resetCheckIn) {
        clearCurrentParticipant();
      }
    } catch (error: any) {
      const msg = `更新に失敗しました: ${error?.message || "unknown"}`;
      setOperatorMessage(msg);
      setKioskMessage(msg);
    }
  }

  function toggleAssignmentVenueFee(name: string, target: "bulk" | "autoOnCheckin") {
    const current = seatAssignmentConfig[target].venueFeeNames;
    const next = current.includes(name)
      ? current.filter((item) => item !== name)
      : [...current, name];
    setSeatAssignmentConfig((prev) => ({
      ...prev,
      [target]: {
        ...prev[target],
        venueFeeNames: next,
      },
    }));
  }

  function parseCsvList(value: string) {
    return value
      .split(/[\n,]/)
      .map((v) => v.trim())
      .filter(Boolean);
  }

  async function assignSeatsByPattern() {
    if (!authSession.authenticated) {
      setAssignmentMessage("対戦台割り当てにはstart.ggログインが必要です");
      return;
    }
    if (!tournamentId) {
      setAssignmentMessage("対象大会を選択してください");
      return;
    }
    if (!seatAssignmentConfig.bulk.venueFeeNames.length) {
      setAssignmentMessage("割り当て対象の枠を1つ以上選択してください");
      return;
    }
    setAssignmentMessage("対戦台を割り当て中...");
    try {
      const res = await fetch(`/api/tournaments/${encodeURIComponent(tournamentId)}/seat-assignment/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: seatAssignmentConfig.bulk,
          overwrite: overwriteSeatAssignment,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || res.statusText);
      setAssignmentMessage(`対戦台を割り当てました（${data.count}名）`);
    } catch (error: any) {
      setAssignmentMessage(`対戦台割り当てに失敗しました: ${error?.message || "unknown"}`);
    }
  }

  function handleCsvUpload(file: File) {
    if (!authSession.authenticated) {
      setOperatorMessage("CSVアップロードにはstart.ggログインが必要です");
      return;
    }
    if (!tournamentId) {
      setOperatorMessage("大会を選択してください");
      return;
    }
    setIsCsvUploading(true);
    setOperatorMessage("CSVを解析・アップロードしています...");
    Papa.parse(file, {
      skipEmptyLines: "greedy",
      complete: (results) => {
        const rows = results.data as string[][];
        const headerIndex = rows.findIndex((row) => {
          const cells = row.map((cell) => String(cell).trim());
          return cells.includes("Id") && (cells.includes("GamerTag") || cells.includes("Short GamerTag"));
        });

        if (headerIndex === -1) {
          setOperatorMessage("ヘッダー行を特定できませんでした");
          setIsCsvUploading(false);
          return;
        }

        const headers = rows[headerIndex].map((cell) => String(cell).trim());
        const dataRows = rows.slice(headerIndex + 1).filter((row) => row.some((cell) => String(cell).trim() !== ""));

        const whitelist = [
          "Id",
          "GamerTag",
          "Short GamerTag",
          "Venue Fee Name",
          "Admin Notes",
          "Checked In",
          "Total Owed",
          "Total Paid",
          "Total Transaction",
        ];

        const indexMap: Record<string, number> = {};
        whitelist.forEach((key) => {
          indexMap[key] = headers.indexOf(key);
        });

        const importedParticipants: Participant[] = dataRows.map((row) => {
          const id = indexMap["Id"] >= 0 ? String(row[indexMap["Id"]]).trim() : "";
          const gamerTag = indexMap["GamerTag"] >= 0 ? String(row[indexMap["GamerTag"]]).trim() : "";
          const shortTag = indexMap["Short GamerTag"] >= 0 ? String(row[indexMap["Short GamerTag"]]).trim() : "";
          const venueFeeName = indexMap["Venue Fee Name"] >= 0 ? String(row[indexMap["Venue Fee Name"]]).trim() : "";
          const adminNotes = indexMap["Admin Notes"] >= 0 ? String(row[indexMap["Admin Notes"]]).trim() : "";
          const totalOwed = Number(row[indexMap["Total Owed"]] || 0);
          const totalPaid = Number(row[indexMap["Total Paid"]] || 0);
          const totalTransaction = Number(row[indexMap["Total Transaction"]] || 0);
          const checkedInRaw = indexMap["Checked In"] >= 0 ? String(row[indexMap["Checked In"]]).trim().toLowerCase() : "false";
          const checkedIn = ["true", "yes", "1"].includes(checkedInRaw);

          return {
            participantId: id,
            playerName: gamerTag || shortTag || id,
            adminNotes,
            venueFeeName,
            payment: {
              totalTransaction,
              totalOwed,
              totalPaid,
            },
            checkedIn,
          };
        }).filter((p) => p.participantId);

        if (!importedParticipants.length) {
          setOperatorMessage("取り込めるデータがありません");
          setIsCsvUploading(false);
          return;
        }

        fetch(`/api/tournaments/${encodeURIComponent(tournamentId)}/participants`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ participants: importedParticipants }),
        })
          .then(async (res) => {
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error || res.statusText);
            const missingNames = Array.isArray(data?.missingParticipants)
              ? data.missingParticipants
                .map((item: any) => String(item?.playerName || item?.participantId || "").trim())
                .filter(Boolean)
              : [];
            const missingPreview = missingNames.slice(0, 5).join(", ");
            const missingSummary = Number(data?.missingCount || 0) > 0
              ? ` / 未検出候補: ${data.missingCount}件${missingPreview ? `（${missingPreview}${missingNames.length > 5 ? " ..." : ""}）` : ""}`
              : "";
            setOperatorMessage(`CSVを保存しました（upsert: ${data.upsertCount || 0}件 / skipped: ${data.skippedCount || 0}件）${missingSummary}`);
          })
          .catch((err) => setOperatorMessage(`CSV保存に失敗しました: ${err.message}`))
          .finally(() => setIsCsvUploading(false));
      },
      error: () => {
        setOperatorMessage("CSVの解析に失敗しました");
        setIsCsvUploading(false);
      },
    });
  }

  function exportParticipantsCsv() {
    if (!participants.length) {
      setOperatorMessage("エクスポート対象の参加者データがありません");
      return;
    }

    const sorted = [...participants].sort((a, b) => a.participantId.localeCompare(b.participantId, "en", { numeric: true }));
    const rows = sorted.map((participant) => ({
      ID: participant.participantId,
      プレイヤー名: getDisplayName(participant),
      枠: participant.venueFeeName || "",
      台番号: participant.seatLabel || participant.adminNotes || "",
      totalTransaction: participant.payment.totalTransaction ?? 0,
      totalOwed: participant.payment.totalOwed ?? 0,
      totalPaid: participant.payment.totalPaid ?? 0,
      チェックイン: participant.checkedIn ? "true" : "false",
    }));
    const csv = Papa.unparse(rows);
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const date = new Date();
    const yyyymmdd = `${date.getFullYear()}${`${date.getMonth() + 1}`.padStart(2, "0")}${`${date.getDate()}`.padStart(2, "0")}`;
    anchor.href = url;
    anchor.download = `participants_export_${tournamentId || "unknown"}_${yyyymmdd}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setOperatorMessage(`CSVをエクスポートしました（${rows.length}件）`);
  }

  const venueFeeOptions = useMemo(
    () => Array.from(new Set(participants.map((p) => (p.venueFeeName || "").trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ja")),
    [participants],
  );
  const playerNameOptions = useMemo(
    () => Array.from(new Set(participants.map((p) => getDisplayName(p).trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ja")),
    [participants],
  );

  useEffect(() => {
    setSeatAssignmentConfig((prev) => ({
      ...prev,
      bulk: {
        ...prev.bulk,
        venueFeeNames: prev.bulk.venueFeeNames.filter((name) => venueFeeOptions.includes(name)),
      },
      autoOnCheckin: {
        ...prev.autoOnCheckin,
        venueFeeNames: prev.autoOnCheckin.venueFeeNames.filter((name) => venueFeeOptions.includes(name)),
      },
    }));
    if (venueFeeFilter !== "all" && !venueFeeOptions.includes(venueFeeFilter)) {
      setVenueFeeFilter("all");
    }
  }, [venueFeeOptions, venueFeeFilter]);

  const filteredParticipants = useMemo(() => {
    const filtered = participants.filter((p) => {
      const matchesSearch = getDisplayName(p).toLowerCase().includes(searchTerm.toLowerCase()) ||
        p.participantId.includes(searchTerm);
      const matchesFilter =
        filter === "all" ||
        (filter === "checkedIn" && p.checkedIn) ||
        (filter === "notCheckedIn" && !p.checkedIn);
      const matchesVenueFee = venueFeeFilter === "all" || (p.venueFeeName || "") === venueFeeFilter;
      return matchesSearch && matchesFilter && matchesVenueFee;
    });
    return filtered.sort((a, b) => {
      if (sortOrder === "idAsc") return a.participantId.localeCompare(b.participantId, "en", { numeric: true });
      if (sortOrder === "idDesc") return b.participantId.localeCompare(a.participantId, "en", { numeric: true });
      if (sortOrder === "nameAsc") return getDisplayName(a).localeCompare(getDisplayName(b), "ja");
      return getDisplayName(b).localeCompare(getDisplayName(a), "ja");
    });
  }, [participants, searchTerm, filter, venueFeeFilter, sortOrder]);

  const assignmentTargets = useMemo(() => {
    if (!seatAssignmentConfig.bulk.venueFeeNames.length) return [];
    return participants
      .filter((p) => seatAssignmentConfig.bulk.venueFeeNames.includes((p.venueFeeName || "").trim()))
      .filter((p) => overwriteSeatAssignment || !(p.adminNotes || "").trim())
      .sort((a, b) => a.participantId.localeCompare(b.participantId, "en", { numeric: true }));
  }, [overwriteSeatAssignment, participants, seatAssignmentConfig.bulk.venueFeeNames]);

  const seatLabelPreview = useMemo(
    () => buildSeatLabels(seatAssignmentConfig.bulk.pattern, assignmentTargets.length).slice(0, 8),
    [seatAssignmentConfig.bulk.pattern, assignmentTargets.length],
  );

  const paymentStatus = scanResult
    ? computePaymentStatus(scanResult, studentDiscount, adjustmentOption, customAmount, pricingConfig)
    : null;

  const disableSubmit = !tournamentId || !scanResult || scanResult.checkedIn ||
    !hasOperatorAccess ||
    (adjustmentOption.requiresReason && (!customReason.trim() || customAmount === 0));
  const disableEditSave = !editingParticipant ||
    (editAdjustmentOption?.requiresReason && (!editCustomReason.trim() || editCustomAmount === 0));

  const participantEditor = editingParticipant ? (
    <div className="editor-modal-backdrop" onClick={() => setEditingParticipant(null)}>
      <div className="stack editor-modal" onClick={(e) => e.stopPropagation()}>
        <div className="flex-between">
          <div style={{ fontWeight: 700 }}>編集: {getDisplayName(editingParticipant)}</div>
          <button className="button secondary" type="button" onClick={() => setEditingParticipant(null)}>閉じる</button>
        </div>
        <label className="label" htmlFor="edit-checked-in">チェックイン状態</label>
        <div className="flex">
          <input
            id="edit-checked-in"
            type="checkbox"
            checked={editCheckedIn}
            onChange={(e) => setEditCheckedIn(e.target.checked)}
          />
          <span className="muted">チェックイン済みにする</span>
        </div>
      <label className="label" htmlFor="edit-admin-notes">対戦台番号</label>
      <input
        id="edit-admin-notes"
        className="input"
        value={editAdminNotes}
        onChange={(e) => setEditAdminNotes(e.target.value)}
        placeholder="例: A-07"
      />
      <label className="label" htmlFor="edit-adjustment">金額変更</label>
      <select
        id="edit-adjustment"
        className="select"
        value={editAdjustmentKey}
        onChange={(e) => setEditAdjustmentKey(e.target.value)}
      >
        {adjustmentOptions().map((opt) => (
          <option key={opt.key} value={opt.key}>{opt.label}</option>
        ))}
      </select>
      {editAdjustmentOption?.requiresReason && (
        <div className="stack">
          <input
            className="input"
            value={editCustomReason}
            onChange={(e) => setEditCustomReason(e.target.value)}
            placeholder="変更理由"
          />
          <input
            className="input"
            type="number"
            value={editCustomAmount}
            onChange={(e) => setEditCustomAmount(Number(e.target.value))}
            placeholder="増減金額"
          />
        </div>
      )}
      <div className="flex" style={{ flexWrap: "wrap" }}>
        <button
          className="button"
          type="button"
          disabled={disableEditSave}
          onClick={() => editingParticipant && updateParticipantStatus(editingParticipant, false)}
        >
          枠・金額変更を保存
        </button>
        <button
          className="button secondary"
          type="button"
          onClick={() => editingParticipant && updateParticipantStatus(editingParticipant, true)}
        >
          未チェックインに戻す
        </button>
      </div>
      </div>
    </div>
  ) : null;

  const accessOverlay = accessOverlayOpen ? (
    <div className="editor-modal-backdrop">
      <div className="stack editor-modal" style={{ maxWidth: 520 }}>
        <div style={{ fontWeight: 700, fontSize: 18 }}>受付モードを選択してください</div>
        <div className="muted">
          start.ggログインまたは大会固有コードで認証すると、受付・チェックイン・チェックイン状況の閲覧が可能になります。
        </div>
        <a className="button" href="/api/auth/login" style={{ textAlign: "center" }}>start.ggでログイン</a>
        <div className="divider" />
        <label className="label" htmlFor="access-code-input">大会固有コード</label>
        <input
          id="access-code-input"
          className="input"
          value={accessCodeInput}
          onChange={(e) => setAccessCodeInput(e.target.value)}
          placeholder="例: ABCD-1234"
        />
        <label className="label" htmlFor="access-handle-input">ハンドルネーム（任意）</label>
        <input
          id="access-handle-input"
          className="input"
          value={accessHandleInput}
          onChange={(e) => setAccessHandleInput(e.target.value)}
          placeholder="受付担当名"
        />
        <button className="button secondary" type="button" onClick={() => verifyTournamentAccessCode()}>
          コードで認証
        </button>
        {accessMessage && <div className="toast">{accessMessage}</div>}
      </div>
    </div>
  ) : null;

  return (
    <div className="container">
      <header>
        <div className="brand">
            <div className="logo">GG</div>
            <div>
              <div style={{ fontWeight: 800, fontSize: 22 }}>AttendeesWebApp</div>
            <div className="muted">QRスキャン / CSVアップロード / ダッシュボード / 遺失物チェック</div>
            </div>
          </div>
        <div className="tablist" role="tablist">
          {[
            { key: "kiosk", label: "受付・QRスキャン" },
            { key: "operator", label: "運営ログイン・CSVアップロード" },
            { key: "dashboard", label: "ダッシュボード" },
            { key: "lostFound", label: "遺失物チェック" },
          ].map((tab) => (
            <button
              key={tab.key}
              className={clsx("tab", { active: activeTab === tab.key })}
              onClick={() => setActiveTab(tab.key as typeof activeTab)}
              role="tab"
            >
              {tab.label}
            </button>
          ))}
        </div>
      </header>

      <div className="card">
        <div className="section-title">start.gg 大会の選択</div>
        <p className="muted">
          start.ggのアカウントでログイン後、マネージャー以上の権限を持つ大会を取得してチェックイン/CSVアップロード/ダッシュボードで使用する大会 ID を選択できます。
        </p>
        <div className="stack" style={{ gap: 8 }}>
          <div className="flex" style={{ gap: 8, flexWrap: "wrap" }}>
            <button className="button" type="button" onClick={fetchManagedTournaments} disabled={!authSession.authenticated || tournamentLoading}>
              {tournamentLoading ? "取得中..." : "start.gg から大会を取得"}
            </button>
            <span className="muted">ログイン済みの場合のみ取得できます</span>
          </div>
          <label className="label" htmlFor="tournament-select">マネージャー以上の権限のある大会を選択</label>
          <select
            id="tournament-select"
            className="select"
            value={tournamentId}
            onChange={(e) => handleTournamentSelect(e.target.value)}
            disabled={tournamentLoading || managedTournaments.length === 0}
          >
            <option value="">start.gg から取得した大会を選択</option>
            {managedTournaments.map((tournament) => (
              <option key={tournament.id} value={tournament.id}>
                {describeTournament(tournament)} [{tournament.id}]
              </option>
            ))}
          </select>
          <div className="muted">選択した大会IDがチェックイン処理・ダッシュボード表示・CSVアップロードの対象になります。</div>
          {tournamentMessage && <div className="toast success">{tournamentMessage}</div>}
          {tournamentError && <div className="toast danger">{tournamentError}</div>}
        </div>
      </div>

      {activeTab === "kiosk" && (
        <div className={clsx("card-grid", { "kiosk-compact": compactKiosk })}>
          <div className="card">
            <div className="flex-between" style={{ marginBottom: 8 }}>
              <div className="section-title" style={{ marginBottom: 0 }}>QRスキャン</div>
            </div>
            {isMobileViewport && <div className="muted">スマホ表示のため簡易UIを自動適用しています。</div>}
            <a className="button secondary" href="/api/auth/login" style={{ width: "100%", textAlign: "center" }}>start.gg ログイン</a>
            <label className="label" htmlFor="kiosk-tournament-select" style={{ marginTop: 8 }}>対象大会</label>
            <select
              id="kiosk-tournament-select"
              className="select"
              value={tournamentId}
              onChange={(e) => handleTournamentSelect(e.target.value)}
            >
              <option value="">大会を選択</option>
              {managedTournaments.map((tournament) => (
                <option key={tournament.id} value={tournament.id}>
                  {describeTournament(tournament)}
                </option>
              ))}
            </select>
            <div ref={scannerContainerRef} style={{ borderRadius: 12, overflow: "hidden" }} />
            {!hasOperatorAccess && <div className="toast">チェックイン処理にはログインが必要です。</div>}
            <div className="divider" />
            <label className="label" htmlFor="manual-qr">手動入力（QR文字列）</label>
            <input
              id="manual-qr"
              className="input"
              value={scanRaw}
              onChange={(e) => setScanRaw(e.target.value)}
              placeholder="http://www.start.gg/api/-/gg_api./participant/01234567/qr?token=..."
              disabled={!hasOperatorAccess}
            />
            <div className="flex" style={{ marginTop: 8 }}>
              <button className="button" onClick={handleManualLookup} disabled={!hasOperatorAccess}>参加者を照合</button>
              {scannerError && <span className="muted">{scannerError}</span>}
            </div>
            {kioskMessage && <div className="toast success" style={{ marginTop: 8 }}>{kioskMessage}</div>}
          </div>

          <div className={clsx("card", { "overlay-card": compactKiosk && scanResult })}>
            <div className="section-title">参加者情報</div>
            {scanResult ? (
              <div className="stack">
                <div className="flex-between">
                  <div style={{ fontSize: 20, fontWeight: 800 }}>{getDisplayName(scanResult)}</div>
                  {scanResult.checkedIn ? (
                    <span className="status success">チェックイン済</span>
                  ) : (
                    <span className={clsx("status", paymentStatus?.status === "prepaid" ? "success" : "danger")}>{paymentStatus?.label}</span>
                  )}
                </div>
                <div className="tag-grid">
                  <span className="badge">ID: {scanResult.participantId}</span>
                  <span className="badge">枠: {scanResult.venueFeeName || "-"}</span>
                  <span className="badge">対戦台: {scanResult.adminNotes || "未割当"}</span>
                  <span className="badge">Total Transaction: {scanResult.payment.totalTransaction}</span>
                  <span className="badge">Total Owed: {scanResult.payment.totalOwed}</span>
                </div>

                <div className="divider" />

                <label className="label">学割</label>
                <div className="flex">
                  <input
                    id="student"
                    type="checkbox"
                    checked={studentDiscount}
                    onChange={(e) => setStudentDiscount(e.target.checked)}
                  />
                  <label htmlFor="student" className="muted">学割を適用</label>
                </div>

                <label className="label" htmlFor="adjustment">枠・金額変更</label>
                <select
                  id="adjustment"
                  className="select"
                  value={selectedAdjustment}
                  onChange={(e) => setSelectedAdjustment(e.target.value)}
                >
                  {adjustmentOptions().map((opt) => (
                    <option key={opt.key} value={opt.key}>{opt.label}</option>
                  ))}
                </select>

                {adjustmentOption.requiresReason && (
                  <div className="stack">
                    <label className="label" htmlFor="custom-reason">理由</label>
                    <input
                      id="custom-reason"
                      className="input"
                      value={customReason}
                      onChange={(e) => setCustomReason(e.target.value)}
                      placeholder="変更理由を入力"
                    />
                    <label className="label" htmlFor="custom-amount">増減金額（例: -1000, 500）</label>
                    <input
                      id="custom-amount"
                      className="input"
                      type="number"
                      value={customAmount}
                      onChange={(e) => setCustomAmount(Number(e.target.value))}
                    />
                  </div>
                )}

                <div className="flex-between" style={{ marginTop: 6 }}>
                  <div className="muted">確認が終わったら、チェックイン確定ボタンを押してください。</div>
                  {paymentStatus && (
                    <span className={clsx("status", paymentStatus.status === "prepaid" ? "success" : "danger")}>{paymentStatus.label}</span>
                  )}
                </div>

                <button className="button" disabled={disableSubmit} onClick={handleCheckIn}>
                  チェックイン確定
                </button>
                <button className="button secondary" type="button" onClick={clearCurrentParticipant}>
                  キャンセルして次へ
                </button>
                {scanResult.checkedIn && <div className="muted">既にチェックインされています</div>}
              </div>
            ) : (
              <div className="muted">QRを読み取ると参加者情報が表示されます</div>
            )}
          </div>
        </div>
      )}

      {activeTab === "lostFound" && (
        <div className="card-grid">
          <div className="card">
            <div className="section-title">遺失物QRスキャン</div>
            <p className="muted">
              大会を選択した状態で、遺失物に付与されたQR（参加者チェックインQRと同形式）を読み取ると、持ち主と対戦台番号を表示します。
            </p>
            {!tournamentId && <div className="toast danger">先に対象大会を選択してください。</div>}
            {!hasOperatorAccess && <div className="toast">読み取りにはログインが必要です。</div>}
            <div ref={lostFoundScannerContainerRef} style={{ borderRadius: 12, overflow: "hidden" }} />
            <div className="divider" />
            <label className="label" htmlFor="lost-found-manual-qr">手動入力（QR文字列）</label>
            <input
              id="lost-found-manual-qr"
              className="input"
              value={lostFoundRaw}
              onChange={(e) => setLostFoundRaw(e.target.value)}
              placeholder="http://www.start.gg/api/-/gg_api./participant/01234567/qr?token=..."
              disabled={!hasOperatorAccess}
            />
            <div className="flex" style={{ marginTop: 8 }}>
              <button className="button" type="button" onClick={handleLostFoundManualLookup} disabled={!hasOperatorAccess}>
                持ち主を照合
              </button>
              {lostFoundError && <span className="muted">{lostFoundError}</span>}
            </div>
          </div>

          <div className="card">
            <div className="section-title">照合結果</div>
            {lostFoundResult ? (
              <div className="stack">
                <div style={{ fontSize: 20, fontWeight: 800 }}>{getDisplayName(lostFoundResult)}</div>
                <div className="tag-grid">
                  <span className="badge">ID: {lostFoundResult.participantId}</span>
                  <span className="badge">枠: {lostFoundResult.venueFeeName || "未設定"}</span>
                  <span className="badge">対戦台: {lostFoundResult.adminNotes || "未割当"}</span>
                </div>
                <div className="muted">
                  遺失物の想定設置場所: {lostFoundResult.adminNotes || "対戦台番号の登録がないため不明"}
                </div>
              </div>
            ) : (
              <div className="muted">QRを読み取ると、持ち主と対戦台番号が表示されます。</div>
            )}
          </div>
        </div>
      )}

      {activeTab === "operator" && (
        <div className="card-grid">
          <div className="card">
            <div className="section-title">データベース リアルタイム同期</div>
            {firestoreReady ? (
              <div className="toast success">参加者データをリアルタイム同期中（{tournamentId}）</div>
            ) : (
              <div className="toast">データベースの設定を確認してください</div>
            )}
            {firestoreError && <div className="toast danger">{firestoreError}</div>}
            <p className="muted">もしデータベースが正しく取得できない場合は、管理者にお問い合わせください。</p>
          </div>

          <div className="card">
            <div className="section-title">大会ごとの料金設定（データベース保存）</div>
            <p className="muted">トーナメントごとに料金設定を保存・取得します。データベースに保存した設定がチェックイン時の金額計算に反映されます。</p>
            <div className="stack">
              <label className="label">選択中のトーナメントID</label>
              <div className="code">{tournamentId || "未選択"}</div>
              <label className="label" htmlFor="tournament-name">大会名（任意でデータベースに保存）</label>
              <input
                id="tournament-name"
                className="input"
                value={pricingName}
                onChange={(e) => setPricingName(e.target.value)}
                placeholder="大会名"
                disabled={!authSession.authenticated}
              />
              <div className="flex" style={{ gap: 8, flexWrap: "wrap" }}>
                <button className="button" type="button" onClick={() => loadPricingConfig(tournamentId)} disabled={!authSession.authenticated}>
                  データベースから取得
                </button>
                <button className="button" type="button" onClick={savePricingConfig} disabled={pricingSaving || !authSession.authenticated}>
                  {pricingSaving ? "保存中..." : "データベースへ保存"}
                </button>
                <span className="muted">取得元: データベース</span>
              </div>
              {pricingMessage && <div className="toast">{pricingMessage}</div>}
            </div>

            <div className="divider" />
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              <div className="stack">
                <label className="label" htmlFor="general-fee">一般料金</label>
                <input
                  id="general-fee"
                  className="input"
                  type="number"
                  value={pricingConfig.generalFee}
                  onChange={(e) => updatePricingField("generalFee", Number(e.target.value))}
                  disabled={!authSession.authenticated}
                />
              </div>
              <div className="stack">
                <label className="label" htmlFor="bring-fee">持参料金</label>
                <input
                  id="bring-fee"
                  className="input"
                  type="number"
                  value={pricingConfig.bringConsoleFee}
                  onChange={(e) => updatePricingField("bringConsoleFee", Number(e.target.value))}
                  disabled={!authSession.authenticated}
                />
              </div>
              <div className="stack">
                <label className="label" htmlFor="student-fee">学割料金</label>
                <input
                  id="student-fee"
                  className="input"
                  type="number"
                  value={pricingConfig.studentFixedFee}
                  onChange={(e) => updatePricingField("studentFixedFee", Number(e.target.value))}
                  disabled={!authSession.authenticated}
                />
              </div>
            </div>

            <div className="divider" />
            <div className="section-title">差額オプション</div>
            <div className="stack" style={{ gap: 12 }}>
              {pricingConfig.adjustmentOptions.map((opt, index) => (
                <div key={index} className="card" style={{ background: "#0d1117" }}>
                  <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
                    <div className="stack">
                      <label className="label">サーバー保存キー</label>
                      <input
                        className="input"
                        value={opt.key}
                        onChange={(e) => updateAdjustment(index, "key", e.target.value)}
                        disabled={!authSession.authenticated}
                      />
                    </div>
                    <div className="stack">
                      <label className="label">ラベル</label>
                      <input
                        className="input"
                        value={opt.label}
                        onChange={(e) => updateAdjustment(index, "label", e.target.value)}
                        disabled={!authSession.authenticated}
                      />
                    </div>
                    <div className="stack">
                      <label className="label">増減金額</label>
                      <input
                        className="input"
                        type="number"
                        value={opt.deltaAmount}
                        onChange={(e) => updateAdjustment(index, "deltaAmount", Number(e.target.value))}
                        disabled={!authSession.authenticated}
                      />
                    </div>
                    <div className="stack">
                      <label className="label">理由入力</label>
                      <div className="flex" style={{ gap: 8 }}>
                        <input
                          type="checkbox"
                          checked={opt.requiresReason}
                          onChange={(e) => updateAdjustment(index, "requiresReason", e.target.checked)}
                          disabled={!authSession.authenticated}
                        />
                        <span className="muted">増減した理由などの入力を必須にする</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex-between" style={{ marginTop: 6 }}>
                    <span className="muted">表示例: {opt.label} / {opt.deltaAmount}円</span>
                    {pricingConfig.adjustmentOptions.length > 1 && (
                      <button className="button secondary" type="button" onClick={() => removeAdjustment(index)} disabled={!authSession.authenticated}>
                        削除
                      </button>
                    )}
                  </div>
                </div>
              ))}
              <button className="button" type="button" onClick={addAdjustment} disabled={!authSession.authenticated}>オプションを追加</button>
            </div>
          </div>

          <div className="card">
            <div className="section-title">start.gg ログイン</div>
            <p className="muted">start.gg にリダイレクトします。</p>
            <div className="stack">
              <a className="button" href="/api/auth/login">start.gg でログイン</a>
              <div className="muted">ログイン後、マネージャー以上の権限がある大会のリストが有効化されます。</div>
              {authSession.authenticated ? (
                <div className="toast success">
                  <div>
                    Startggアカウントでログイン済です。
                  </div>
                  <div className="flex" style={{ gap: 8 }}>
                    <button className="button" onClick={refreshSession}>状態を再取得</button>
                    <button className="button secondary" onClick={logout}>ログアウト</button>
                  </div>
                </div>
              ) : (
                <div className="toast">未ログインです。上のボタンからログインを行ってください。</div>
              )}
              {authError && <div className="toast danger">{authError}</div>}
              <div className="divider" />
              <div className="section-title" style={{ marginBottom: 0 }}>大会固有コード発行（ログイン必須）</div>
              <button
                className="button secondary"
                type="button"
                onClick={issueTournamentAccessCode}
                disabled={!authSession.authenticated || issuingAccessCode || !tournamentId}
              >
                {issuingAccessCode ? "発行中..." : "大会コードを発行 / 再発行"}
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={loadAccessCodeHistory}
                disabled={!authSession.authenticated || !tournamentId}
              >
                履歴を再取得
              </button>
              {activeAccessCode && <div className="code">現在有効なコード: {activeAccessCode}</div>}
              {shareUrl && (
                <div className="stack">
                  <input className="input" value={shareUrl} readOnly />
                  <button className="button secondary" type="button" onClick={copyShareUrl}>共有URLをコピー</button>
                  {shareQrUrl && <img src={shareQrUrl} alt="大会コード共有QR" style={{ width: 220, height: 220, borderRadius: 8 }} />}
                </div>
              )}
              <div className="stack">
                {accessCodeHistory.map((item) => (
                  <div key={`${item.codeHash}-${item.createdAt}`} className="card" style={{ background: "#0d1117" }}>
                    <div className="flex-between">
                      <code>{item.maskedCode || item.codeHash.slice(0, 12)}</code>
                      <span className={clsx("status", item.status === "active" ? "success" : "danger")}>{item.status}</span>
                    </div>
                    <div className="muted">発行: {item.createdAt || "-"}</div>
                    <div className="muted">更新: {item.updatedAt || "-"}</div>
                    <div className="flex" style={{ gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                      <button
                        className="button secondary"
                        type="button"
                        onClick={() => updateAccessCodeStatus(item.codeHash, "activate")}
                        disabled={item.status === "active"}
                      >
                        有効化
                      </button>
                      <button
                        className="button secondary"
                        type="button"
                        onClick={() => updateAccessCodeStatus(item.codeHash, "disable")}
                        disabled={item.status !== "active"}
                      >
                        無効化
                      </button>
                      <button
                        className="button secondary"
                        type="button"
                        onClick={() => updateAccessCodeStatus(item.codeHash, "delete")}
                        disabled={item.status === "deleted"}
                      >
                        削除
                      </button>
                    </div>
                  </div>
                ))}
                {accessCodeHistory.length === 0 && <div className="muted">履歴はまだありません</div>}
              </div>
              {accessCodeAdminMessage && <div className="toast">{accessCodeAdminMessage}</div>}
            </div>
          </div>

          <div className="card">
            <div className="section-title">参加者CSVアップロード</div>
            <p className="muted">参加者情報をCSVから取得し、データベースへアップロードします。台番号を指定したい場合は「Admin Notes」、枠の分類は「Venue Fee Name」列を利用してください。</p>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleCsvUpload(file);
              }}
              className="input"
              disabled={!authSession.authenticated}
            />
            <div className="flex" style={{ marginTop: 8, gap: 8 }}>
              <button className="button secondary" type="button" onClick={exportParticipantsCsv} disabled={isCsvUploading}>
                最新参加者CSVをエクスポート
              </button>
            </div>
            {operatorMessage && <div className="toast" style={{ marginTop: 8 }}>{operatorMessage}</div>}
            <div className="divider" />
            <div className="muted">個人情報はアップロード前に破棄されます。CSV再アップロード時はチェックイン/席情報を維持しつつupsertし、未検出参加者は即時削除せず候補としてマークします。</div>
          </div>
        </div>
      )}

      {activeTab === "dashboard" && (
        <div className="card">
          <div className="section-title">チェックイン状況</div>
          {!hasOperatorAccess && <div className="toast">一覧の閲覧にはログインが必要です。</div>}
          {hasOperatorAccess && (
            <>
          <div className="stack" style={{ marginBottom: 12 }}>
            <div className="section-title" style={{ marginBottom: 0 }}>対戦台の一括割り当て</div>
            <div className="muted">
              枠（Venue Fee Name）を選んで、フォーマットで台番号を自動生成して割り当てます。例: <code>{"{Alphabet:A:D}-{Int:1:4}"}</code> / 総人数は <code>{"{Count}"}</code> で参照できます。
            </div>
            <div className="flex" style={{ flexWrap: "wrap", gap: 8 }}>
              {venueFeeOptions.map((name) => (
                <label key={name} className="muted" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={seatAssignmentConfig.bulk.venueFeeNames.includes(name)}
                    onChange={() => toggleAssignmentVenueFee(name, "bulk")}
                    disabled={!authSession.authenticated}
                  />
                  {name}
                </label>
              ))}
              {venueFeeOptions.length === 0 && <span className="muted">Venue Fee Name が未登録です</span>}
            </div>
            <div className="flex" style={{ gap: 8, flexWrap: "wrap" }}>
              <input
                className="input"
                value={seatAssignmentConfig.bulk.pattern}
                onChange={(e) => setSeatAssignmentConfig((prev) => ({ ...prev, bulk: { ...prev.bulk, pattern: e.target.value } }))}
                placeholder="{Alphabet:A:D}-{Int:1:4}"
                disabled={!authSession.authenticated}
              />
              <label className="muted" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  type="checkbox"
                  checked={overwriteSeatAssignment}
                  onChange={(e) => setOverwriteSeatAssignment(e.target.checked)}
                  disabled={!authSession.authenticated}
                />
                既存の台番号を上書き
              </label>
              <button className="button" type="button" onClick={assignSeatsByPattern} disabled={!authSession.authenticated}>一括割り当て実行</button>
            </div>
            <label className="label">強制的に予備台へ割り当てるプレイヤー名（カンマ or 改行区切り）</label>
            <input
              className="input"
              list="player-name-suggestions"
              value={seatAssignmentConfig.bulk.exceptionPlayerNames.join(", ")}
              onChange={(e) => setSeatAssignmentConfig((prev) => ({
                ...prev,
                bulk: { ...prev.bulk, exceptionPlayerNames: parseCsvList(e.target.value) },
              }))}
              placeholder="Skyline, Luna"
              disabled={!authSession.authenticated}
            />
            <datalist id="player-name-suggestions">
              {playerNameOptions.map((name) => (
                <option key={`bulk-name-${name}`} value={name} />
              ))}
            </datalist>
            <label className="label">予備台プレフィックス</label>
            <input
              className="input"
              value={seatAssignmentConfig.bulk.reserveLabelPrefix}
              onChange={(e) => setSeatAssignmentConfig((prev) => ({ ...prev, bulk: { ...prev.bulk, reserveLabelPrefix: e.target.value } }))}
              placeholder="予備台"
              disabled={!authSession.authenticated}
            />
            <div className="muted">
              対象人数: {assignmentTargets.length}名 / 生成プレビュー: {seatLabelPreview.length ? seatLabelPreview.join(", ") : "（未生成）"}
            </div>
            <div className="divider" />
            <div className="section-title" style={{ marginBottom: 0 }}>チェックイン時の自動対戦台割り当て</div>
            <label className="muted" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={seatAssignmentConfig.autoOnCheckin.enabled}
                onChange={(e) => setSeatAssignmentConfig((prev) => ({
                  ...prev,
                  autoOnCheckin: { ...prev.autoOnCheckin, enabled: e.target.checked },
                }))}
                disabled={!authSession.authenticated}
              />
              チェックイン時に自動で対戦台を割り当てる
            </label>
            <div className="flex" style={{ flexWrap: "wrap", gap: 8 }}>
              {venueFeeOptions.map((name) => (
                <label key={`auto-${name}`} className="muted" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={seatAssignmentConfig.autoOnCheckin.venueFeeNames.includes(name)}
                    onChange={() => toggleAssignmentVenueFee(name, "autoOnCheckin")}
                    disabled={!authSession.authenticated}
                  />
                  {name}
                </label>
              ))}
            </div>
            <input
              className="input"
              value={seatAssignmentConfig.autoOnCheckin.pattern}
              onChange={(e) => setSeatAssignmentConfig((prev) => ({
                ...prev,
                autoOnCheckin: { ...prev.autoOnCheckin, pattern: e.target.value },
              }))}
              placeholder="{Alphabet:A:D}-{Int:1:4}"
              disabled={!authSession.authenticated}
            />
            <input
              className="input"
              list="player-name-suggestions-auto"
              value={seatAssignmentConfig.autoOnCheckin.exceptionPlayerNames.join(", ")}
              onChange={(e) => setSeatAssignmentConfig((prev) => ({
                ...prev,
                autoOnCheckin: { ...prev.autoOnCheckin, exceptionPlayerNames: parseCsvList(e.target.value) },
              }))}
              placeholder="自動割り当てで予備台にするプレイヤー名（カンマ or 改行区切り）"
              disabled={!authSession.authenticated}
            />
            <datalist id="player-name-suggestions-auto">
              {playerNameOptions.map((name) => (
                <option key={`auto-name-${name}`} value={name} />
              ))}
            </datalist>
            <input
              className="input"
              value={seatAssignmentConfig.autoOnCheckin.reserveLabelPrefix}
              onChange={(e) => setSeatAssignmentConfig((prev) => ({
                ...prev,
                autoOnCheckin: { ...prev.autoOnCheckin, reserveLabelPrefix: e.target.value },
              }))}
              placeholder="予備台"
              disabled={!authSession.authenticated}
            />
            <div className="flex" style={{ gap: 8, flexWrap: "wrap" }}>
              <button className="button secondary" type="button" onClick={saveSeatAssignmentConfig} disabled={assignmentSaving || !authSession.authenticated}>
                {assignmentSaving ? "保存中..." : "台番号設定を保存"}
              </button>
              <button className="button secondary" type="button" onClick={() => loadSeatAssignmentConfig(tournamentId)} disabled={!tournamentId || !authSession.authenticated}>
                設定を再読み込み
              </button>
            </div>
            {assignmentMessage && <div className="toast">{assignmentMessage}</div>}
          </div>

          <div className="flex" style={{ marginBottom: 12 }}>
            <input
              className="input"
              placeholder="ID または プレイヤー名で検索"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <select className="select" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
              <option value="all">すべて</option>
              <option value="checkedIn">チェックイン済み</option>
              <option value="notCheckedIn">未チェックイン</option>
            </select>
            <select className="select" value={venueFeeFilter} onChange={(e) => setVenueFeeFilter(e.target.value)}>
              <option value="all">枠: すべて</option>
              {venueFeeOptions.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
            <select className="select" value={sortOrder} onChange={(e) => setSortOrder(e.target.value as typeof sortOrder)}>
              <option value="idAsc">ID昇順</option>
              <option value="idDesc">ID降順</option>
              <option value="nameAsc">名前昇順</option>
              <option value="nameDesc">名前降順</option>
            </select>
          </div>

          {isMobileViewport ? (
            <div className="stack" style={{ gap: 10 }}>
              {filteredParticipants.map((p) => {
                const status = computePaymentStatus(
                  p,
                  false,
                  { key: "none", label: "変更なし", deltaAmount: 0, requiresReason: false },
                  0,
                  pricingConfig,
                );
                return (
                  <div key={p.participantId} className="card" style={{ background: "#0d1117" }}>
                    <div className="flex-between">
                      <strong>{getDisplayName(p)}</strong>
                      <span className={clsx("status", status.status === "prepaid" ? "success" : "danger")}>{status.label}</span>
                    </div>
                    <div className="muted">ID: {p.participantId}</div>
                    <div className="muted">枠: {p.venueFeeName || "-"}</div>
                    <div className="muted">台番号: {p.adminNotes || "-"}</div>
                    <div className="muted">チェックイン: {p.checkedIn ? formatTimestampJst(new Date(p.checkedInAt || "")) : "未"}</div>
                    <button className="button secondary" type="button" onClick={() => openParticipantEditor(p)}>編集</button>
                  </div>
                );
              })}
              {filteredParticipants.length === 0 && <div className="muted">該当データがありません</div>}
            </div>
          ) : (
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>プレイヤー名</th>
                    <th>枠</th>
                    <th>台番号</th>
                    <th>支払い</th>
                    <th>チェックイン</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredParticipants.map((p) => {
                    const status = computePaymentStatus(
                      p,
                      false,
                      { key: "none", label: "変更なし", deltaAmount: 0, requiresReason: false },
                      0,
                      pricingConfig,
                    );
                    return (
                      <tr key={p.participantId}>
                        <td>{p.participantId}</td>
                        <td>{getDisplayName(p)}</td>
                        <td>{p.venueFeeName || "-"}</td>
                        <td>{p.adminNotes || "-"}</td>
                        <td>
                          <span className={clsx("status", status.status === "prepaid" ? "success" : "danger")}>{status.label}</span>
                        </td>
                        <td>{p.checkedIn ? formatTimestampJst(new Date(p.checkedInAt || "")) : "未"}</td>
                        <td>
                          <button
                            className="button secondary"
                            type="button"
                            onClick={() => {
                              openParticipantEditor(p);
                            }}
                          >
                            編集
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {filteredParticipants.length === 0 && (
                    <tr>
                      <td colSpan={8} className="muted">該当データがありません</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
            </>
          )}
        </div>
      )}
      {participantEditor}
      {accessOverlay}
    </div>
  );
}
