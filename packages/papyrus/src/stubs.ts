/**
 * Minimal declarations of the most-used Skyrim script API, written from the
 * public Creation Kit documentation. They give completions and type checks
 * before the real sources (Data/Source/Scripts or Data/Scripts/Source) are
 * indexed; real sources always replace these.
 */
export const STUB_SOURCES: Record<string, string> = {
  Form: `Scriptname Form Hidden
Int Function GetFormID() native
String Function GetName() native
Bool Function HasKeyword(Keyword akKeyword) native
Bool Function PlayerKnows() native
Function RegisterForUpdate(Float afInterval) native
Function RegisterForSingleUpdate(Float afInterval) native
Function UnregisterForUpdate() native
Function RegisterForSingleUpdateGameTime(Float afInterval) native
Function RegisterForSleep() native
Function StartObjectProfiling() native
Event OnInit()
EndEvent
Event OnUpdate()
EndEvent
Event OnUpdateGameTime()
EndEvent
Event OnSleepStart(Float afSleepStartTime, Float afDesiredSleepEndTime)
EndEvent
Event OnSleepStop(Bool abInterrupted)
EndEvent
Event OnStoryScript(Keyword akKeyword, Location akLocation, ObjectReference akRef1, ObjectReference akRef2, Int aiValue1, Int aiValue2)
EndEvent
`,
  ObjectReference: `Scriptname ObjectReference extends Form Hidden
Bool Function Activate(ObjectReference akActivator, Bool abDefaultProcessingOnly = False) native
Function AddItem(Form akItemToAdd, Int aiCount = 1, Bool abSilent = False) native
Function RemoveItem(Form akItemToRemove, Int aiCount = 1, Bool abSilent = False, ObjectReference akOtherContainer = None) native
Function RemoveAllItems(ObjectReference akTransferTo = None, Bool abKeepOwnership = False, Bool abRemoveQuestItems = False) native
Int Function GetItemCount(Form akItem) native
Function Enable(Bool abFadeIn = False) native
Function Disable(Bool abFadeOut = False) native
Function Delete() native
Bool Function IsDisabled() native
Bool Function IsEnabled()
  Return !IsDisabled()
EndFunction
Function MoveTo(ObjectReference akTarget, Float afXOffset = 0.0, Float afYOffset = 0.0, Float afZOffset = 0.0, Bool abMatchRotation = True) native
ObjectReference Function PlaceAtMe(Form akFormToPlace, Int aiCount = 1, Bool abForcePersist = False, Bool abInitiallyDisabled = False) native
Actor Function PlaceActorAtMe(ActorBase akActorToPlace, Int aiLevelMod = 4, EncounterZone akZone = None) native
Float Function GetDistance(ObjectReference akOther) native
Float Function GetPositionX() native
Float Function GetPositionY() native
Float Function GetPositionZ() native
Function SetPosition(Float afX, Float afY, Float afZ) native
Function SetAngle(Float afXAngle, Float afYAngle, Float afZAngle) native
Function SetScale(Float afScale) native
Float Function GetScale() native
Form Function GetBaseObject() native
Cell Function GetParentCell() native
WorldSpace Function GetWorldSpace() native
Location Function GetCurrentLocation() native
Bool Function IsInLocation(Location akLocation) native
ObjectReference Function GetLinkedRef(Keyword apKeyword = None) native
Bool Function IsLocked() native
Function Lock(Bool abLock = True, Bool abAsOwner = False) native
Function SetOpen(Bool abOpen = True) native
Int Function GetOpenState() native
Function BlockActivation(Bool abBlocked = True) native
Function SetActorOwner(ActorBase akActorBase) native
Function SetFactionOwner(Faction akFaction) native
Bool Function Is3DLoaded() native
Function PlayAnimation(String asAnimation) native
Bool Function PlayGamebryoAnimation(String asAnimation, Bool abStartOver = False, Float afEaseInTime = 0.0) native
Function SendStealAlarm(Actor akThief) native
Function KnockAreaEffect(Float afMagnitude, Float afRadius) native
Event OnActivate(ObjectReference akActionRef)
EndEvent
Event OnLoad()
EndEvent
Event OnUnload()
EndEvent
Event OnCellLoad()
EndEvent
Event OnCellAttach()
EndEvent
Event OnCellDetach()
EndEvent
Event OnTriggerEnter(ObjectReference akActionRef)
EndEvent
Event OnTriggerLeave(ObjectReference akActionRef)
EndEvent
Event OnContainerChanged(ObjectReference akNewContainer, ObjectReference akOldContainer)
EndEvent
Event OnItemAdded(Form akBaseItem, Int aiItemCount, ObjectReference akItemReference, ObjectReference akSourceContainer)
EndEvent
Event OnItemRemoved(Form akBaseItem, Int aiItemCount, ObjectReference akItemReference, ObjectReference akDestContainer)
EndEvent
Event OnHit(ObjectReference akAggressor, Form akSource, Projectile akProjectile, Bool abPowerAttack, Bool abSneakAttack, Bool abBashAttack, Bool abHitBlocked)
EndEvent
Event OnEquipped(Actor akActor)
EndEvent
Event OnUnequipped(Actor akActor)
EndEvent
Event OnOpen(ObjectReference akActionRef)
EndEvent
Event OnClose(ObjectReference akActionRef)
EndEvent
Event OnRead()
EndEvent
Event OnReset()
EndEvent
`,
  Actor: `Scriptname Actor extends ObjectReference Hidden
Bool Function PlayIdle(Idle akIdle) native
Bool Function PlayIdleWithTarget(Idle akIdle, ObjectReference akTarget) native
Function SetLookAt(ObjectReference akTarget, Bool abPathingLookAt = False) native
Function ClearLookAt() native
Float Function GetActorValue(String asValueName) native
Float Function GetAV(String asValueName)
  Return GetActorValue(asValueName)
EndFunction
Function SetActorValue(String asValueName, Float afValue) native
Function SetAV(String asValueName, Float afValue)
  SetActorValue(asValueName, afValue)
EndFunction
Function ModActorValue(String asValueName, Float afAmount) native
Function DamageActorValue(String asValueName, Float afDamage) native
Function RestoreActorValue(String asValueName, Float afAmount) native
ActorBase Function GetActorBase() native
ActorBase Function GetLeveledActorBase() native
Race Function GetRace() native
Function SetRace(Race akRace = None) native
Bool Function IsDead() native
Function Kill(Actor akKiller = None) native
Function Resurrect() native
Function EvaluatePackage() native
Function StartCombat(Actor akTarget) native
Function StopCombat() native
Bool Function IsInCombat() native
Function AddToFaction(Faction akFaction) native
Function RemoveFromFaction(Faction akFaction) native
Bool Function IsInFaction(Faction akFaction) native
Int Function GetFactionRank(Faction akFaction) native
Function SetFactionRank(Faction akFaction, Int aiRank) native
Function SetOutfit(Outfit akOutfit, Bool abSleepOutfit = False) native
Function EquipItem(Form akItem, Bool abPreventRemoval = False, Bool abSilent = False) native
Function UnequipItem(Form akItem, Bool abPreventEquip = False, Bool abSilent = False) native
Bool Function IsEquipped(Form akItem) native
Bool Function AddSpell(Spell akSpell, Bool abVerbose = True) native
Bool Function RemoveSpell(Spell akSpell) native
Bool Function HasSpell(Form akForm) native
Function SetGhost(Bool abIsGhost = True) native
Function SetRestrained(Bool abRestrained = True) native
Function SetDontMove(Bool abDontMove = True) native
Function SetPlayerTeammate(Bool abTeammate = True, Bool abCanDoFavor = True) native
Bool Function IsPlayerTeammate() native
Function SetRelationshipRank(Actor akOther, Int aiRank) native
Int Function GetRelationshipRank(Actor akOther) native
Function SendAssaultAlarm() native
Bool Function IsSneaking() native
Bool Function IsWeaponDrawn() native
Int Function GetLevel() native
Event OnDeath(Actor akKiller)
EndEvent
Event OnDying(Actor akKiller)
EndEvent
Event OnCombatStateChanged(Actor akTarget, Int aeCombatState)
EndEvent
Event OnObjectEquipped(Form akBaseObject, ObjectReference akReference)
EndEvent
Event OnObjectUnequipped(Form akBaseObject, ObjectReference akReference)
EndEvent
Event OnPackageStart(Package akNewPackage)
EndEvent
Event OnPackageEnd(Package akOldPackage)
EndEvent
Event OnSit(ObjectReference akFurniture)
EndEvent
Event OnGetUp(ObjectReference akFurniture)
EndEvent
Event OnLocationChange(Location akOldLoc, Location akNewLoc)
EndEvent
Event OnEnterBleedout()
EndEvent
Event OnRaceSwitchComplete()
EndEvent
`,
  Quest: `Scriptname Quest extends Form Hidden
Bool Function SetStage(Int aiStage) native
Int Function GetStage() native
Int Function GetCurrentStageID()
  Return GetStage()
EndFunction
Bool Function GetStageDone(Int aiStage) native
Bool Function IsStageDone(Int aiStage)
  Return GetStageDone(aiStage)
EndFunction
Bool Function IsRunning() native
Bool Function IsActive() native
Bool Function IsCompleted() native
Bool Function IsStarting() native
Bool Function IsStopping() native
Bool Function IsStopped() native
Bool Function Start() native
Function Stop() native
Function Reset() native
Function SetActive(Bool abActive = True) native
Function CompleteQuest() native
Function CompleteAllObjectives() native
Function FailAllObjectives() native
Function SetObjectiveDisplayed(Int aiObjective, Bool abDisplayed = True, Bool abForce = False) native
Function SetObjectiveCompleted(Int aiObjective, Bool abCompleted = True) native
Function SetObjectiveFailed(Int aiObjective, Bool abFailed = True) native
Bool Function IsObjectiveDisplayed(Int aiObjective) native
Bool Function IsObjectiveCompleted(Int aiObjective) native
Bool Function IsObjectiveFailed(Int aiObjective) native
Alias Function GetAlias(Int aiAliasID) native
Bool Function ModObjectiveGlobal(Float afModValue, GlobalVariable aModGlobal, Int aiObjectiveID = -1, Float afTargetValue = -1.0, Bool abCountingUp = True, Bool abCompleteObjective = True, Bool abRedisplayObjective = True) native
Function UpdateCurrentInstanceGlobal(GlobalVariable aUpdateGlobal) native
Event OnStoryActivateActor(Location akLocation, ObjectReference akActor)
EndEvent
`,
  Alias: `Scriptname Alias Hidden
Quest Function GetOwningQuest() native
String Function GetName() native
Int Function GetID() native
Event OnInit()
EndEvent
`,
  ReferenceAlias: `Scriptname ReferenceAlias extends Alias Hidden
ObjectReference Function GetReference() native
ObjectReference Function GetRef()
  Return GetReference()
EndFunction
Actor Function GetActorReference()
  Return GetReference() as Actor
EndFunction
Actor Function GetActorRef()
  Return GetReference() as Actor
EndFunction
Function ForceRefTo(ObjectReference akNewRef) native
Function ForceRefIfEmpty(ObjectReference akNewRef) native
Function Clear() native
Function TryToMoveTo(ObjectReference akTarget)
EndFunction
Function TryToEnable()
EndFunction
Function TryToDisable()
EndFunction
Bool Function TryToEvaluatePackage()
EndFunction
Event OnActivate(ObjectReference akActionRef)
EndEvent
Event OnDeath(Actor akKiller)
EndEvent
Event OnLoad()
EndEvent
Event OnTriggerEnter(ObjectReference akActionRef)
EndEvent
Event OnItemAdded(Form akBaseItem, Int aiItemCount, ObjectReference akItemReference, ObjectReference akSourceContainer)
EndEvent
Event OnContainerChanged(ObjectReference akNewContainer, ObjectReference akOldContainer)
EndEvent
Event OnLocationChange(Location akOldLoc, Location akNewLoc)
EndEvent
Event OnCombatStateChanged(Actor akTarget, Int aeCombatState)
EndEvent
`,
  LocationAlias: `Scriptname LocationAlias extends Alias Hidden
Location Function GetLocation() native
Function ForceLocationTo(Location akNewLocation) native
Function Clear() native
`,
  ActiveMagicEffect: `Scriptname ActiveMagicEffect Hidden
Actor Function GetTargetActor() native
Actor Function GetCasterActor() native
Function Dispel() native
MagicEffect Function GetBaseObject() native
Event OnEffectStart(Actor akTarget, Actor akCaster)
EndEvent
Event OnEffectFinish(Actor akTarget, Actor akCaster)
EndEvent
`,
  Debug: `Scriptname Debug Hidden
Function Notification(String asNotificationText) global native
Function MessageBox(String asMessageBoxText) global native
Function Trace(String asTextToPrint, Int aiSeverity = 0) global native
Function TraceStack(String asTextToPrint = "Tracing stack on request", Int aiSeverity = 0) global native
Function SendAnimationEvent(ObjectReference arRef, String asEventName) global native
Function ToggleCollisions() global native
Function QuitGame() global native
`,
  Game: `Scriptname Game Hidden
Actor Function GetPlayer() global native
Form Function GetForm(Int aiFormID) global native
Form Function GetFormFromFile(Int aiFormID, String asFilename) global native
Function DisablePlayerControls(Bool abMovement = True, Bool abFighting = True, Bool abCamSwitch = False, Bool abLooking = False, Bool abSneaking = False, Bool abMenu = True, Bool abActivate = True, Bool abJournalTabs = False, Int aiDisablePOVType = 0) global native
Function EnablePlayerControls(Bool abMovement = True, Bool abFighting = True, Bool abCamSwitch = True, Bool abLooking = True, Bool abSneaking = True, Bool abMenu = True, Bool abActivate = True, Bool abJournalTabs = True, Int aiDisablePOVType = 0) global native
Function FadeOutGame(Bool abFadingOut, Bool abBlackFade, Float afSecsBeforeFade, Float afFadeDuration) global native
Function ForceThirdPerson() global native
Function ForceFirstPerson() global native
Function RequestSave() global native
Function RequestAutoSave() global native
Function ShakeCamera(ObjectReference akSource = None, Float afStrength = 0.5, Float afDuration = 0.0) global native
Function IncrementStat(String asStatName, Int aiModAmount = 1) global native
Function AddAchievement(Int aiAchievementID) global native
Function PlayBink(String asFileName, Bool abInterruptible = False, Bool abMuteAudio = True, Bool abMuteMusic = True, Bool abLetterbox = True) global native
ObjectReference Function FindClosestReferenceOfType(Form arBaseObject, Float afX, Float afY, Float afZ, Float afRadius) global native
Actor Function FindClosestActor(Float afX, Float afY, Float afZ, Float afRadius) global native
Function TeachWord(WordOfPower akWord) global native
Function SetInChargen(Bool abDisableSaving, Bool abDisableWaiting, Bool abShowControlsDisabledMessage) global native
`,
  Utility: `Scriptname Utility Hidden
Function Wait(Float afSeconds) global native
Function WaitMenuMode(Float afSeconds) global native
Function WaitGameTime(Float afHours) global native
Int Function RandomInt(Int aiMin = 0, Int aiMax = 100) global native
Float Function RandomFloat(Float afMin = 0.0, Float afMax = 1.0) global native
Float Function GetCurrentRealTime() global native
Float Function GetCurrentGameTime() global native
String Function GameTimeToString(Float afGameTime) global native
Bool Function IsInMenuMode() global native
`,
  Math: `Scriptname Math Hidden
Float Function Abs(Float afValue) global native
Float Function Sqrt(Float afValue) global native
Float Function Pow(Float x, Float y) global native
Float Function Sin(Float afValue) global native
Float Function Cos(Float afValue) global native
Int Function Floor(Float afValue) global native
Int Function Ceiling(Float afValue) global native
`,
  GlobalVariable: `Scriptname GlobalVariable extends Form Hidden
Float Function GetValue() native
Int Function GetValueInt()
  Return GetValue() as Int
EndFunction
Function SetValue(Float afNewValue) native
Function SetValueInt(Int aiNewValue)
  SetValue(aiNewValue as Float)
EndFunction
Float Function Mod(Float afHowMuch)
  SetValue(GetValue() + afHowMuch)
  Return GetValue()
EndFunction
`,
  Scene: `Scriptname Scene extends Form Hidden
Function Start() native
Function ForceStart() native
Function Stop() native
Bool Function IsPlaying() native
Bool Function IsActionComplete(Int aiActionID) native
Quest Function GetOwningQuest() native
`,
  Message: `Scriptname Message extends Form Hidden
Int Function Show(Float afArg1 = 0.0, Float afArg2 = 0.0, Float afArg3 = 0.0, Float afArg4 = 0.0, Float afArg5 = 0.0, Float afArg6 = 0.0, Float afArg7 = 0.0, Float afArg8 = 0.0, Float afArg9 = 0.0) native
Function ShowAsHelpMessage(String asEvent, Float afDuration, Float afInterval, Int aiMaxTimes) native
`,
  TopicInfo: `Scriptname TopicInfo extends Form Hidden
Quest Function GetOwningQuest() native
Event OnBegin(ObjectReference akSpeakerRef, Bool abHasBeenSaid)
EndEvent
Event OnEnd(ObjectReference akSpeakerRef, Bool abHasBeenSaid)
EndEvent
`,
  Package: `Scriptname Package extends Form Hidden
Quest Function GetOwningQuest() native
Package Function GetTemplate() native
`,
  Perk: `Scriptname Perk extends Form Hidden`,
  Faction: `Scriptname Faction extends Form Hidden
Int Function GetReaction(Faction akOther) native
Function SetReaction(Faction akOther, Int aiNewValue) native
Function SetAlly(Faction akOther, Bool abSelfIsFriendToOther = False, Bool abOtherIsFriendToSelf = False) native
Function SetEnemy(Faction akOther, Bool abSelfIsNeutralToOther = False, Bool abOtherIsNeutralToSelf = False) native
Int Function GetFactionGold() native
Function ModCrimeGold(Int aiAmount, Bool abViolent = False) native
`,
  Spell: `Scriptname Spell extends Form Hidden
Function Cast(ObjectReference akSource, ObjectReference akTarget = None) native
Function RemoteCast(ObjectReference akSource, Actor akBlameActor, ObjectReference akTarget = None) native
`,
  ActorBase: `Scriptname ActorBase extends Form Hidden
Class Function GetClass() native
Int Function GetSex() native
Bool Function IsEssential() native
Function SetEssential(Bool abEssential = True) native
Bool Function IsProtected() native
Function SetProtected(Bool abProtected = True) native
Bool Function IsUnique() native
Race Function GetRace() native
`,
  Keyword: `Scriptname Keyword extends Form Hidden
Function SendStoryEvent(Location akLoc = None, ObjectReference akRef1 = None, ObjectReference akRef2 = None, Int aiValue1 = 0, Int aiValue2 = 0) native
Bool Function SendStoryEventAndWait(Location akLoc = None, ObjectReference akRef1 = None, ObjectReference akRef2 = None, Int aiValue1 = 0, Int aiValue2 = 0) native
`,
  FormList: `Scriptname FormList extends Form Hidden
Function AddForm(Form apForm) native
Int Function GetSize() native
Form Function GetAt(Int aiIndex) native
Bool Function HasForm(Form akForm) native
Function RemoveAddedForm(Form apForm) native
Function Revert() native
`,
  Location: `Scriptname Location extends Form Hidden
Bool Function IsCleared() native
Bool Function IsChild(Location akOther) native
Bool Function HasEverBeenCleared() native
`,
  Cell: `Scriptname Cell extends Form Hidden
Bool Function IsAttached() native
Bool Function IsInterior() native
Function SetFogColor(Int aiNearRed, Int aiNearGreen, Int aiNearBlue, Int aiFarRed, Int aiFarGreen, Int aiFarBlue) native
`,
  MiscObject: `Scriptname MiscObject extends Form Hidden`,
  Weapon: `Scriptname Weapon extends Form Hidden
Function Fire(ObjectReference akSource, Ammo akAmmo = None) native
`,
  Armor: `Scriptname Armor extends Form Hidden`,
  Book: `Scriptname Book extends Form Hidden`,
  Key: `Scriptname Key extends MiscObject Hidden`,
  Potion: `Scriptname Potion extends Form Hidden`,
  Ingredient: `Scriptname Ingredient extends Form Hidden`,
  Ammo: `Scriptname Ammo extends Form Hidden`,
  Activator: `Scriptname Activator extends Form Hidden`,
  Container: `Scriptname Container extends Form Hidden`,
  Door: `Scriptname Door extends Form Hidden`,
  Furniture: `Scriptname Furniture extends Activator Hidden`,
  Light: `Scriptname Light extends Form Hidden`,
  Static: `Scriptname Static extends Form Hidden`,
  Race: `Scriptname Race extends Form Hidden`,
  Class: `Scriptname Class extends Form Hidden`,
  Outfit: `Scriptname Outfit extends Form Hidden`,
  Idle: `Scriptname Idle extends Form Hidden`,
  Sound: `Scriptname Sound extends Form Hidden
Int Function Play(ObjectReference akSource) native
Bool Function PlayAndWait(ObjectReference akSource) native
`,
  MagicEffect: `Scriptname MagicEffect extends Form Hidden`,
  Enchantment: `Scriptname Enchantment extends Form Hidden`,
  Shout: `Scriptname Shout extends Form Hidden`,
  WordOfPower: `Scriptname WordOfPower extends Form Hidden`,
  WorldSpace: `Scriptname WorldSpace extends Form Hidden`,
  EncounterZone: `Scriptname EncounterZone extends Form Hidden`,
  LocationRefType: `Scriptname LocationRefType extends Keyword Hidden`,
  LeveledItem: `Scriptname LeveledItem extends Form Hidden
Function AddForm(Form apForm, Int auiLevel, Int auiCount) native
Function Revert() native
`,
  LeveledActor: `Scriptname LeveledActor extends Form Hidden
Function AddForm(Form apForm, Int auiLevel) native
Function Revert() native
`,
  Projectile: `Scriptname Projectile extends Form Hidden`,
  Topic: `Scriptname Topic extends Form Hidden
Function Add() native
`,
  VoiceType: `Scriptname VoiceType extends Form Hidden`,
  ImageSpaceModifier: `Scriptname ImageSpaceModifier extends Form Hidden
Function Apply(Float afStrength = 1.0) native
Function Remove() native
`,
  EffectShader: `Scriptname EffectShader extends Form Hidden
Function Play(ObjectReference akObject, Float afDuration = -1.0) native
Function Stop(ObjectReference akObject) native
`,
  VisualEffect: `Scriptname VisualEffect extends Form Hidden
Function Play(ObjectReference akObject, Float afTime = -1.0, ObjectReference akFacingObject = None) native
Function Stop(ObjectReference akObject) native
`,
  Explosion: `Scriptname Explosion extends Form Hidden`,
  Hazard: `Scriptname Hazard extends Form Hidden`,
  SoulGem: `Scriptname SoulGem extends MiscObject Hidden`,
  TextureSet: `Scriptname TextureSet extends Form Hidden`,
  Weather: `Scriptname Weather extends Form Hidden
Function SetActive(Bool abOverride = False, Bool abAccelerate = False) native
Function ForceActive(Bool abOverride = False) native
`,
  AssociationType: `Scriptname AssociationType extends Form Hidden`,
};
