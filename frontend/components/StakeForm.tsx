"use client";

import { useState, useEffect, useCallback } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { parseEther, decodeEventLog } from "viem";
import { SHIPSTAKE_ABI, SHIPSTAKE_ADDRESS, BACKEND_URL, explorerTxUrl } from "@/lib/contract";
import { monadTestnet } from "@/lib/wagmi";
import { fetchUserRepos, fetchUserPRs, type GithubSession, type GithubRepo, type GithubPR } from "@/lib/github-auth";
import { friendlyWalletError } from "@/lib/errors";

type Status = "idle" | "staking" | "registering" | "done" | "error";

const PRESETS = [
  { label: "3 days", ms: 3 * 24 * 60 * 60 * 1000 },
  { label: "1 week", ms: 7 * 24 * 60 * 60 * 1000 },
  { label: "2 weeks", ms: 14 * 24 * 60 * 60 * 1000 },
];

export function StakeForm({
  githubSession,
  onStakeCreated,
}: {
  githubSession: GithubSession | null;
  onStakeCreated: () => void;
}) {
  const { address, isConnected, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: monadTestnet.id });
  const { data: walletClient } = useWalletClient({ chainId: monadTestnet.id });

  const [repos, setRepos] = useState<GithubRepo[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);
  const [selectedRepo, setSelectedRepo] = useState("");

  const [prs, setPrs] = useState<GithubPR[]>([]);
  const [loadingPrs, setLoadingPrs] = useState(false);
  const [prsError, setPrsError] = useState<string | null>(null);
  const [manualMode, setManualMode] = useState(false);
  const [prUrl, setPrUrl] = useState("");

  const [presetIndex, setPresetIndex] = useState(1);
  const [amount, setAmount] = useState("0.01");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const wrongNetwork = isConnected && chainId !== monadTestnet.id;
  const canSubmit = isConnected && !!githubSession && !wrongNetwork;

  const loadRepos = useCallback(async () => {
    if (!githubSession) return;
    setLoadingRepos(true);
    setReposError(null);
    try {
      const list = await fetchUserRepos(githubSession.username);
      setRepos(list);
    } catch {
      setReposError("Couldn't reach the backend to load your repos.");
    } finally {
      setLoadingRepos(false);
    }
  }, [githubSession]);

  useEffect(() => {
    setSelectedRepo("");
    setPrs([]);
    setPrUrl("");
    setManualMode(false);
    setRepos([]);
    setReposError(null);
    if (githubSession) loadRepos();
  }, [githubSession, loadRepos]);

  const loadPRs = useCallback(async () => {
    if (!githubSession || !selectedRepo) return;
    setLoadingPrs(true);
    setPrsError(null);
    try {
      const list = await fetchUserPRs(githubSession.username, selectedRepo);
      setPrs(list);
    } catch {
      setPrsError("Couldn't reach the backend to load pull requests.");
    } finally {
      setLoadingPrs(false);
    }
  }, [githubSession, selectedRepo]);

  useEffect(() => {
    setPrUrl("");
    setPrs([]);
    setPrsError(null);
    if (selectedRepo) loadPRs();
  }, [selectedRepo, loadPRs]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!isConnected || !address) {
      setError("Connect your wallet first.");
      return;
    }
    if (wrongNetwork) {
      setError("Switch your wallet to Monad Testnet first (button in the top right).");
      return;
    }
    if (!walletClient || !publicClient) {
      setError("Wallet not ready yet — try again in a moment.");
      return;
    }
    if (!githubSession) {
      setError("Connect GitHub first.");
      return;
    }
    if (!prUrl || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\/?$/.test(prUrl)) {
      setError("Select or paste a valid GitHub PR URL.");
      return;
    }

    try {
      setStatus("staking");
      const deadlineDate = new Date(Date.now() + PRESETS[presetIndex].ms);
      const deadlineUnix = BigInt(Math.floor(deadlineDate.getTime() / 1000));
      const value = parseEther(amount);

      const gasEstimate = await publicClient.estimateContractGas({
        address: SHIPSTAKE_ADDRESS,
        abi: SHIPSTAKE_ABI,
        functionName: "createStake",
        args: [deadlineUnix],
        value,
        account: address,
      });
      const gasLimit = gasEstimate + gasEstimate / 10n;

      const hash = await walletClient.writeContract({
        address: SHIPSTAKE_ADDRESS,
        abi: SHIPSTAKE_ABI,
        functionName: "createStake",
        args: [deadlineUnix],
        value,
        gas: gasLimit,
        chain: monadTestnet,
        account: address,
      });
      setTxHash(hash);

      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      const event = receipt.logs
        .map((log) => {
          try {
            return decodeEventLog({ abi: SHIPSTAKE_ABI, data: log.data, topics: log.topics });
          } catch {
            return null;
          }
        })
        .find((e) => e?.eventName === "StakeCreated");

      if (!event || event.eventName !== "StakeCreated") {
        throw new Error("Stake created on-chain but couldn't read the stakeId back.");
      }

      const stakeId = Number(event.args.stakeId);

      setStatus("registering");
      const res = await fetch(`${BACKEND_URL}/stakes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stakeId,
          ownerAddress: address,
          amountWei: value.toString(),
          prUrl,
          githubToken: githubSession.token,
          deadline: deadlineDate.toISOString(),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? "Stake went on-chain but the backend rejected it.");
      }

      setStatus("done");
      setPrUrl("");
      onStakeCreated();
    } catch (err) {
      setStatus("error");
      setError(friendlyWalletError(err));
    }
  }

  return (
    <form onSubmit={handleSubmit} className="glass-panel rounded-3xl p-6">
      <h2 className="mb-5 font-display text-lg font-semibold">New Stake</h2>

      {wrongNetwork && (
        <div className="mb-4 rounded-xl bg-rust/15 p-3 text-sm text-rust">
          Wrong network — switch to Monad Testnet using the button in the top right.
        </div>
      )}

      {!canSubmit && !wrongNetwork && (
        <div className="glass-row mb-4 rounded-xl p-3 text-sm text-muted">
          Connect your wallet and GitHub above to create a stake.
        </div>
      )}

      {!manualMode ? (
        <>
          <div className="mb-4">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-sm text-muted">Repository</span>
              {githubSession && (
                <button
                  type="button"
                  onClick={() => setManualMode(true)}
                  className="text-xs text-purple underline hover:text-purple/80"
                >
                  Paste a link instead
                </button>
              )}
            </div>
            <select
              value={selectedRepo}
              onChange={(e) => setSelectedRepo(e.target.value)}
              disabled={!canSubmit || loadingRepos}
              className="glass-input w-full rounded-xl px-4 py-2.5 text-paper disabled:opacity-50"
            >
              <option value="" disabled>
                {loadingRepos ? "Loading your repos…" : "Select a repository"}
              </option>
              {repos.map((repo) => (
                <option key={repo.fullName} value={repo.fullName}>
                  {repo.fullName}{repo.fork ? " (fork)" : ""}
                </option>
              ))}
            </select>
            {reposError && (
              <div className="mt-1.5 flex items-center justify-between text-xs text-rust">
                <span>{reposError}</span>
                <button type="button" onClick={loadRepos} className="underline hover:text-rust/80">
                  Retry
                </button>
              </div>
            )}
          </div>

          {selectedRepo && (
            <div className="mb-4">
              <span className="mb-1.5 block text-sm text-muted">Pull Request</span>
              <select
                value={prUrl}
                onChange={(e) => setPrUrl(e.target.value)}
                disabled={!canSubmit || loadingPrs}
                className="glass-input w-full rounded-xl px-4 py-2.5 text-paper disabled:opacity-50"
                required
              >
                <option value="" disabled>
                  {loadingPrs ? "Loading pull requests…" : prs.length === 0 ? "No pull requests found" : "Select a pull request"}
                </option>
                {prs.map((pr) => (
                  <option key={pr.url} value={pr.url}>
                    #{pr.number} — {pr.title.length > 50 ? pr.title.slice(0, 50) + "…" : pr.title}
                    {pr.merged ? " · merged" : pr.state === "closed" ? " · closed" : ""}
                  </option>
                ))}
              </select>
              {prsError && (
                <div className="mt-1.5 flex items-center justify-between text-xs text-rust">
                  <span>{prsError}</span>
                  <button type="button" onClick={loadPRs} className="underline hover:text-rust/80">
                    Retry
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="mb-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-sm text-muted">Pull Request URL</span>
            {githubSession && repos.length > 0 && (
              <button
                type="button"
                onClick={() => setManualMode(false)}
                className="text-xs text-purple underline hover:text-purple/80"
              >
                Pick from my repos
              </button>
            )}
          </div>
          <input
            value={prUrl}
            onChange={(e) => setPrUrl(e.target.value)}
            placeholder="https://github.com/owner/repo/pull/42"
            disabled={!canSubmit}
            className="glass-input w-full rounded-xl px-4 py-2.5 text-paper placeholder:text-muted focus:ring-2 focus:ring-purple disabled:opacity-50"
            required
          />
        </div>
      )}

      <div className="mb-4">
        <span className="mb-1.5 block text-sm text-muted">Deadline</span>
        <div className="flex gap-2">
          {PRESETS.map((preset, i) => (
            <button
              key={preset.label}
              type="button"
              disabled={!canSubmit}
              onClick={() => setPresetIndex(i)}
              className={`flex-1 rounded-xl py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                presetIndex === i
                  ? "bg-purple text-white"
                  : "glass-row text-muted hover:text-paper"
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <label className="mb-6 block">
        <span className="mb-1.5 block text-sm text-muted">Stake Amount (MON)</span>
        <input
          type="number"
          step="0.001"
          min="0.001"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={!canSubmit}
          className="glass-input w-full rounded-xl px-4 py-2.5 text-paper focus:ring-2 focus:ring-purple disabled:opacity-50"
          required
        />
      </label>

      {error && <div className="mb-4 text-sm text-rust">{error}</div>}
      {txHash && (
        <a
          href={explorerTxUrl(txHash)}
          target="_blank"
          rel="noopener noreferrer"
          className="mb-4 block break-all font-mono text-xs text-purple underline hover:text-purple/80"
        >
          View transaction on Monad Explorer &#8599;
        </a>
      )}

      <button
        type="submit"
        disabled={!canSubmit || status === "staking" || status === "registering"}
        className="w-full rounded-full bg-purple py-3 font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {status === "staking" ? "Staking…" : status === "registering" ? "Saving…" : "Create Stake"}
      </button>
    </form>
  );
}
