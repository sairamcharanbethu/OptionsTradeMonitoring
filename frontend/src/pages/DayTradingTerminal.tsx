import { useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { PanelBody, PanelTabs, TabCount, usePanelTab, type PanelTab } from '@/components/ui/panel-tabs';
import SetupCard from '@/components/daytrading/SetupCard';
import PositionsStrip from '@/components/daytrading/PositionsStrip';
import DecisionLog from '@/components/daytrading/DecisionLog';
import PositionSummary from '@/components/daytrading/PositionSummary';
import TerminalHeaderBar from '@/components/daytrading/TerminalHeaderBar';
import StrategyLanes from '@/components/daytrading/StrategyLanes';
import LifecycleHero from '@/components/daytrading/LifecycleHero';
import PaperActivityPanel from '@/components/daytrading/PaperActivityPanel';
import StrategyAccountCard from '@/components/daytrading/StrategyAccountCard';
import ReviewOrderBar from '@/components/daytrading/ReviewOrderBar';
import ActionMessageBanner from '@/components/daytrading/ActionMessageBanner';
import EntryReviewBanner from '@/components/daytrading/EntryReviewBanner';
import AiReviewCard from '@/components/daytrading/AiReviewCard';
import WhySetupCard from '@/components/daytrading/WhySetupCard';
import SetupHistoryCard from '@/components/daytrading/SetupHistoryCard';
import ServicesCard from '@/components/daytrading/ServicesCard';
import PaperCloseDialog from '@/components/daytrading/PaperCloseDialog';
import DismissSignalDialog from '@/components/daytrading/DismissSignalDialog';
import ExecuteSignalDialog from '@/components/daytrading/ExecuteSignalDialog';
import { useDayTradingTerminal } from '@/hooks/useDayTradingTerminal';

export default function DayTradingTerminal() {
  const model = useDayTradingTerminal();
  const {
    services,
    healthError,
    refreshing,
    executeSignal,
    setExecuteSignal,
    dismissSignal,
    setDismissSignal,
    executing,
    dismissing,
    reconcilingBroker,
    browserAlertsEnabled,
    actionMessage,
    setActionMessage,
    riskAssessment,
    riskLoading,
    paperUpdating,
    paperClosePosition,
    setPaperClosePosition,
    highlightedPositionId,
    setHighlightedPositionId,
    paperClosing,
    paperForceCloseAvailable,
    setPaperForceCloseAvailable,
    riskError,
    paperExpanded,
    setPaperExpanded,
    paperActivityTab,
    paperActivityFilter,
    setPaperActivityFilter,
    paperActivitySearch,
    setPaperActivitySearch,
    aiReviewExpanded,
    setAiReviewExpanded,
    historyExpanded,
    setHistoryExpanded,
    diagnosticsExpanded,
    setDiagnosticsExpanded,
    armToggling,
    confirmRearm,
    isConnected,
    signalsLoading,
    strategyState,
    settings,
    tradeUsage,
    killSwitch,
    killSwitchUnavailable,
    positions,
    paperAccount,
    refetchPaperAccount,
    strategyHistory,
    historyLoading,
    historyError,
    refetchHistory,
    strategySignal,
    strategyLanes,
    strategySetupId,
    currentSignal,
    lifecycle,
    side,
    directionConfirmed,
    setup,
    option,
    targets,
    confirmations,
    strategyBlockers,
    executionMode,
    liveKillSwitch,
    liveHalted,
    liveDisarmed,
    handleDisarmLive,
    handleArmLive,
    plannedContracts,
    orderQuantity,
    plannedLimit,
    orderDebit,
    strategyDebitLimit,
    snapshotAge,
    quoteAge,
    freshSnapshot,
    marketDataBlocked,
    usageRemaining,
    dismissedActionableSetup,
    primaryGex,
    gexAge,
    linkedPosition,
    executionStatus,
    brokerPositionOpen,
    executionBlockers,
    strategyCanExecute,
    canExecute,
    executionSubmitting,
    executionStarted,
    executionSkipped,
    brokerReportsFill,
    executionNeedsReview,
    entryReviewAvailable,
    displayLifecycle,
    lifecycleView,
    currentTone,
    currentStrategyCode,
    currentStrategy,
    spot,
    vwap,
    fiveMinuteStructure,
    spotVsVwap,
    trigger,
    invalidation,
    exitTargetNumber,
    targetOne,
    targetTwo,
    hasLevelPlan,
    optionSelected,
    rewardRisk,
    spreadPct,
    brokerName,
    brokerOrderId,
    brokerSyncAt,
    autonomousResult,
    autonomousLastAttemptAt,
    executionMessage,
    heartbeatSummary,
    heartbeatLabel,
    dismissStillCurrent,
    approvalSecondsRemaining,
    canConfirmExecution,
    approvalBlocker,
    marketSessionLabel,
    staleReviewReason,
    reviewDataFresh,
    refreshAll,
    reconcileBrokerOrder,
    runAdHocRiskReview,
    toggleBrowserAlerts,
    togglePaperAutomation,
    confirmPaperClose,
    requestExecution,
    confirmExecution,
    cancelSetup,
    strategyHealth,
    ibkrHealth,
    systemReady,
    diagnostics,
    paperUnrealizedPnl,
    paperAvailableCash,
    filteredPaperOrders,
    filteredPaperJournal,
    filteredPaperPositions,
    selectPaperActivityTab,
    signalDismissed
  } = model;

  // The cockpit answers one question above the fold: act, or wait. Everything
  // below is evidence for that answer, and evidence should not cost a scroll
  // during an entry window — so it lives behind tabs rather than in a stack.
  const openCount = (positions || []).filter((position: any) => String(position?.status || '').toUpperCase() === 'OPEN').length
    + (paperAccount?.openPositions?.length || 0);
  const unhealthy = useMemo(
    () => (diagnostics || []).filter((row) => {
      const status = String(row?.status || '').toUpperCase();
      return status && !['UP', 'OK', 'HEALTHY', 'LIVE', 'RUNNING', 'CONNECTED', 'MARKET_CLOSED', 'N/A'].includes(status);
    }).length,
    [diagnostics]
  );

  const panels: PanelTab[] = useMemo(() => [
    { id: 'plan', label: 'Plan' },
    { id: 'positions', label: 'Positions', badge: <TabCount n={openCount} /> },
    { id: 'log', label: 'Decision log' },
    { id: 'health', label: 'Health', badge: <TabCount n={unhealthy} tone="critical" /> }
  ], [openCount, unhealthy]);

  const [panel, setPanel] = usePanelTab('strikepilot.cockpit.panel', panels, 'plan');

  return (
    <main className="day-trading-terminal page-shell space-y-3 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3 text-zinc-100 sm:space-y-4 sm:pt-3">
      {/* ---- Decision surface. Pinned, never behind a tab, never below a fold. -- */}
      <section className="overflow-hidden rounded-xl border border-zinc-800/90 bg-[#0d0f12] shadow-[0_24px_80px_rgba(0,0,0,0.28)]">
        <TerminalHeaderBar
          services={services}
          refreshing={refreshing}
          browserAlertsEnabled={browserAlertsEnabled}
          armToggling={armToggling}
          confirmRearm={confirmRearm}
          isConnected={isConnected}
          strategyState={strategyState}
          settings={settings}
          tradeUsage={tradeUsage}
          killSwitch={killSwitch}
          killSwitchUnavailable={killSwitchUnavailable}
          positions={positions}
          lifecycle={lifecycle}
          setup={setup}
          executionMode={executionMode}
          liveKillSwitch={liveKillSwitch}
          liveHalted={liveHalted}
          liveDisarmed={liveDisarmed}
          handleDisarmLive={handleDisarmLive}
          handleArmLive={handleArmLive}
          snapshotAge={snapshotAge}
          freshSnapshot={freshSnapshot}
          usageRemaining={usageRemaining}
          marketSessionLabel={marketSessionLabel}
          refreshAll={refreshAll}
          toggleBrowserAlerts={toggleBrowserAlerts}
          strategyHealth={strategyHealth}
          ibkrHealth={ibkrHealth}
          systemReady={systemReady}
        />

        <StrategyLanes
          strategyLanes={strategyLanes}
          setup={setup}
        />

        <LifecycleHero
          setDismissSignal={setDismissSignal}
          reconcilingBroker={reconcilingBroker}
          positions={positions}
          strategySignal={strategySignal}
          currentSignal={currentSignal}
          lifecycle={lifecycle}
          side={side}
          directionConfirmed={directionConfirmed}
          setup={setup}
          option={option}
          targets={targets}
          strategyBlockers={strategyBlockers}
          executionMode={executionMode}
          plannedContracts={plannedContracts}
          orderQuantity={orderQuantity}
          plannedLimit={plannedLimit}
          orderDebit={orderDebit}
          snapshotAge={snapshotAge}
          quoteAge={quoteAge}
          freshSnapshot={freshSnapshot}
          marketDataBlocked={marketDataBlocked}
          dismissedActionableSetup={dismissedActionableSetup}
          gexAge={gexAge}
          linkedPosition={linkedPosition}
          executionStatus={executionStatus}
          brokerPositionOpen={brokerPositionOpen}
          executionBlockers={executionBlockers}
          strategyCanExecute={strategyCanExecute}
          canExecute={canExecute}
          executionSubmitting={executionSubmitting}
          executionStarted={executionStarted}
          executionSkipped={executionSkipped}
          brokerReportsFill={brokerReportsFill}
          executionNeedsReview={executionNeedsReview}
          displayLifecycle={displayLifecycle}
          lifecycleView={lifecycleView}
          currentTone={currentTone}
          currentStrategyCode={currentStrategyCode}
          currentStrategy={currentStrategy}
          spot={spot}
          vwap={vwap}
          fiveMinuteStructure={fiveMinuteStructure}
          spotVsVwap={spotVsVwap}
          trigger={trigger}
          invalidation={invalidation}
          exitTargetNumber={exitTargetNumber}
          targetOne={targetOne}
          targetTwo={targetTwo}
          hasLevelPlan={hasLevelPlan}
          optionSelected={optionSelected}
          rewardRisk={rewardRisk}
          brokerName={brokerName}
          brokerOrderId={brokerOrderId}
          brokerSyncAt={brokerSyncAt}
          autonomousResult={autonomousResult}
          autonomousLastAttemptAt={autonomousLastAttemptAt}
          executionMessage={executionMessage}
          heartbeatSummary={heartbeatSummary}
          heartbeatLabel={heartbeatLabel}
          marketSessionLabel={marketSessionLabel}
          reconcileBrokerOrder={reconcileBrokerOrder}
          requestExecution={requestExecution}
        />
      </section>

      {/* Transient — each of these renders null unless it is currently relevant. */}
      <ReviewOrderBar
        side={side}
        requestExecution={requestExecution}
        lifecycle={lifecycle}
        signalDismissed={signalDismissed}
        executionMode={executionMode}
        canExecute={canExecute}
      />

      <ActionMessageBanner
        actionMessage={actionMessage}
      />

      <EntryReviewBanner
        setup={setup}
        plannedContracts={plannedContracts}
        orderQuantity={orderQuantity}
        orderDebit={orderDebit}
        strategyDebitLimit={strategyDebitLimit}
        invalidation={invalidation}
        entryReviewAvailable={entryReviewAvailable}
      />

      {/* An open position is a decision input, not evidence — it stays pinned. */}
      {linkedPosition && (
        <PositionSummary
          position={linkedPosition}
          option={option}
          side={side}
          spot={strategySignal?.spot || linkedPosition.underlying_price}
          invalidation={setup?.invalidation || linkedPosition.underlying_stop_price}
          target={targetTwo}
        />
      )}

      {signalsLoading && !currentSignal && (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading strategy state
        </div>
      )}

      {/* ---- Evidence. One tab deep, never a scroll. ------------------------- */}
      <PanelTabs tabs={panels} active={panel} onSelect={setPanel} aria-label="Cockpit evidence" />

      <PanelBody id="plan" active={panel}>
        <SetupCard
          signal={strategySignal}
          side={side}
          setup={setup || null}
          option={option}
          setupId={strategySetupId}
          vetoed={strategyState?.setupVetoed === true}
          settings={settings}
          lifecycle={lifecycle}
        />

        <WhySetupCard
          setup={setup}
          confirmations={confirmations}
          primaryGex={primaryGex}
          gexAge={gexAge}
        />

        <AiReviewCard
          riskAssessment={riskAssessment}
          riskLoading={riskLoading}
          riskError={riskError}
          aiReviewExpanded={aiReviewExpanded}
          setAiReviewExpanded={setAiReviewExpanded}
          settings={settings}
          currentSignal={currentSignal}
          setup={setup}
          snapshotAge={snapshotAge}
          quoteAge={quoteAge}
          gexAge={gexAge}
          entryReviewAvailable={entryReviewAvailable}
          staleReviewReason={staleReviewReason}
          reviewDataFresh={reviewDataFresh}
          runAdHocRiskReview={runAdHocRiskReview}
        />
      </PanelBody>

      <PanelBody id="positions" active={panel}>
        <PositionsStrip
          positions={positions}
          paperPositions={paperAccount?.openPositions || []}
          paperCanManage={paperAccount?.canManage === true}
          settings={settings}
          highlightedId={highlightedPositionId}
          onPaperChanged={() => { void refetchPaperAccount(); }}
        />

        <StrategyAccountCard
          setActionMessage={setActionMessage}
          paperUpdating={paperUpdating}
          setPaperClosePosition={setPaperClosePosition}
          paperClosing={paperClosing}
          setPaperForceCloseAvailable={setPaperForceCloseAvailable}
          paperExpanded={paperExpanded}
          setPaperExpanded={setPaperExpanded}
          paperActivityTab={paperActivityTab}
          paperActivityFilter={paperActivityFilter}
          setPaperActivityFilter={setPaperActivityFilter}
          paperActivitySearch={paperActivitySearch}
          setPaperActivitySearch={setPaperActivitySearch}
          strategyState={strategyState}
          positions={positions}
          paperAccount={paperAccount}
          lifecycle={lifecycle}
          setup={setup}
          option={option}
          executionStatus={executionStatus}
          togglePaperAutomation={togglePaperAutomation}
          diagnostics={diagnostics}
          paperUnrealizedPnl={paperUnrealizedPnl}
          paperAvailableCash={paperAvailableCash}
          filteredPaperOrders={filteredPaperOrders}
          filteredPaperJournal={filteredPaperJournal}
          filteredPaperPositions={filteredPaperPositions}
          selectPaperActivityTab={selectPaperActivityTab}
        />
      </PanelBody>

      <PanelBody id="log" active={panel}>
        <DecisionLog
          onHighlightPosition={(id) => {
            setHighlightedPositionId(id);
            if (id != null) document.getElementById(`position-row-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }}
          highlightedId={highlightedPositionId}
          currentSetupId={strategySetupId}
        />

        <SetupHistoryCard
          historyExpanded={historyExpanded}
          setHistoryExpanded={setHistoryExpanded}
          strategyHistory={strategyHistory}
          historyLoading={historyLoading}
          historyError={historyError}
          refetchHistory={refetchHistory}
          lifecycle={lifecycle}
          setup={setup}
        />
      </PanelBody>

      <PanelBody id="health" active={panel}>
        <ServicesCard
          services={services}
          healthError={healthError}
          diagnosticsExpanded={diagnosticsExpanded}
          setDiagnosticsExpanded={setDiagnosticsExpanded}
          diagnostics={diagnostics}
        />
      </PanelBody>

      <PaperCloseDialog
        actionMessage={actionMessage}
        paperClosePosition={paperClosePosition}
        setPaperClosePosition={setPaperClosePosition}
        paperClosing={paperClosing}
        paperForceCloseAvailable={paperForceCloseAvailable}
        setPaperForceCloseAvailable={setPaperForceCloseAvailable}
        confirmPaperClose={confirmPaperClose}
      />

      <DismissSignalDialog
        dismissSignal={dismissSignal}
        setDismissSignal={setDismissSignal}
        dismissing={dismissing}
        setup={setup}
        dismissStillCurrent={dismissStillCurrent}
        cancelSetup={cancelSetup}
      />

      <ExecuteSignalDialog
        executeSignal={executeSignal}
        setExecuteSignal={setExecuteSignal}
        executing={executing}
        lifecycle={lifecycle}
        side={side}
        setup={setup}
        option={option}
        targets={targets}
        executionMode={executionMode}
        orderQuantity={orderQuantity}
        plannedLimit={plannedLimit}
        orderDebit={orderDebit}
        snapshotAge={snapshotAge}
        quoteAge={quoteAge}
        gexAge={gexAge}
        invalidation={invalidation}
        spreadPct={spreadPct}
        approvalSecondsRemaining={approvalSecondsRemaining}
        canConfirmExecution={canConfirmExecution}
        approvalBlocker={approvalBlocker}
        marketSessionLabel={marketSessionLabel}
        confirmExecution={confirmExecution}
      />
    </main>
  );
}
