% Schauplatz rules layer — consumed together with the scene's fact export.
%
% The scene states what IS true (rooms, adjacency, whereabouts intervals,
% sets, named times). This file states what FOLLOWS — the domain axioms.
% This starter library speaks detective; write your own vocabulary for
% machines, logistics, or whatever your scene models. The playground
% loads this file next to the facts and answers any `?- goal` statements
% in the scene against both.
%
:- use_module(library(lists)).  % member/2, select/3 for the pairing solver

% Fact vocabulary (see LANGUAGE.md "Fact export"):
%   room(R).  adjacent(A, B).  set_member(Set, X).
%   in(X, Room, T0, T1).  time_fact(Name, Seconds).  lifetime(X, T0, T1).
%   visible(A, B, T0, T1).  — sight intervals, exported for SET MEMBERS

% X is in room R at time T (interval ends inclusive — a leap arrives
% exactly at its instant, and final-instant facts are real).
present_at(X, R, T) :- in(X, R, T0, T1), T0 =< T, T =< T1.

% The unknown-room convention: a person parked in a room named `unknown`
% is UNACCOUNTED FOR — they have to be somewhere, and "somewhere" could
% be anywhere. could_be_at/3 is presence weakened by that ignorance.
could_be_at(X, R, T) :- present_at(X, R, T).
could_be_at(X, R, T) :- present_at(X, unknown, T), room(R), R \= unknown.

% Alibi: X is provably somewhere else at time T (a real room, accounted).
alibi(X, R, T) :- present_at(X, Elsewhere, T), Elsewhere \= R, Elsewhere \= unknown.

% Who from a set could have been in room R at named time TN?
% This is the narrowing query: run it as clues pin people down and
% watch the candidate list shrink toward one.
%   ?- could(suspects, X, lion_enclosure, time_of_death)
could(Set, X, R, TN) :-
    time_fact(TN, T),
    set_member(Set, X),
    could_be_at(X, R, T),
    \+ alibi(X, R, T).

% The eliminations — who is CLEARED for room R at named time TN, and
% where their alibi places them. cleared/5 and could/4 partition the
% set: every member is one or the other. The case-file pattern:
%   ?- cleared(suspects, X, beach_hut, time_of_death, Where)
%   ?- could(suspects, X, beach_hut, time_of_death)
%   ?- sole(suspects, X, beach_hut, time_of_death)
cleared(Set, X, R, TN, Where) :-
    time_fact(TN, T),
    set_member(Set, X),
    present_at(X, Where, T),
    Where \= R, Where \= unknown.

% The verdict: exactly one member of the set lacks an alibi.
%   ?- sole(suspects, X, lion_enclosure, time_of_death)
sole(Set, X, R, TN) :-
    could(Set, X, R, TN),
    \+ (could(Set, Y, R, TN), Y \= X).

% ---- sight ---------------------------------------------------------------
% visible/4 is sees() published as data: intervals where the line
% between two set members' centers is clear and both are present.

visible_at(A, B, T) :- visible(A, B, T0, T1), T0 =< T, T =< T1.
ever_visible(A, B) :- visible(A, B, _, _).

% Surveillance: does Watcher see EVERY member of Set at named time TN?
% (Double negation — "there is no member it fails to see".)
%   ?- all_visible(camera, crates, audit)
all_visible(Watcher, Set, TN) :-
    time_fact(TN, T),
    \+ (set_member(Set, C), C \= Watcher, \+ visible_at(Watcher, C, T)).

% The blind spot, named: which member does Watcher NOT see at TN?
%   ?- unseen(camera, crates, audit, C)
unseen(Watcher, Set, TN, C) :-
    time_fact(TN, T),
    set_member(Set, C),
    C \= Watcher,
    \+ visible_at(Watcher, C, T).

% ---- order -----------------------------------------------------------------
% left_of(A, B) facts describe the END of the timeline — where things
% settled (a deduction-time scene exports its solved arrangement).
% "Immediately" and "ends" only mean something within a PEER GROUP, so
% these take the set: a gift box between two houses shouldn't break
% "the houses are neighbors".

immediately_left_of(Set, A, B) :-
    set_member(Set, A), set_member(Set, B),
    left_of(A, B),
    \+ (set_member(Set, C), left_of(A, C), left_of(C, B)).

next_to(Set, A, B) :- immediately_left_of(Set, A, B).
next_to(Set, A, B) :- immediately_left_of(Set, B, A).

at_end(Set, A) :- set_member(Set, A), \+ (set_member(Set, C), left_of(C, A)).
at_end(Set, A) :- set_member(Set, A), \+ (set_member(Set, C), left_of(A, C)).

% ---- co-location -----------------------------------------------------------
% where is X at named time TN? (output last)
%   ?- where(body, found, R)
where(X, TN, R) :- time_fact(TN, T), present_at(X, R, T).

% A and B share a room at TN — easy-Murdle "possession" is co-location.
% The unknown room doesn't count: two things parked in the staging room
% aren't "together", so a clue goal stated early reads no, not true.
with(A, B, TN) :-
    time_fact(TN, T),
    present_at(A, R, T), present_at(B, R, T),
    R \= unknown, A \= B.

% ---- testimony (liar puzzles) ----------------------------------------------
% "The murderer lies; everyone else tells the truth." Each statement is
% true EXACTLY WHEN its speaker is not the killer. Claim is any goal
% term — the clue's content, meta-called:
%   testimony(Killer, earl_grey, present_at(first_student, field, 0))
% reads: "Earl Grey testified that First Student was in the field."
testimony(Killer, Speaker, Claim) :- call(Claim), Killer \= Speaker.
testimony(Killer, Speaker, Claim) :- \+ call(Claim), Killer = Speaker.

% ---- pairing ---------------------------------------------------------------
% The Murdle grid, solved: pair every member of SetA with a DISTINCT
% member of SetB, consistent with a list of constraints. The engine
% searches; multiple answers mean the clues don't determine it yet —
% watch the answers shrink as you add constraints. Place the surviving
% pairing in the scene and let the checks certify it.
%
%   ?- pair_up(suspects, weapons,
%              [holds(chancellor, flag), no(ivory, crowbar),
%               one_of([umber, honey], ruby_pin)], P)
%
% Constraint forms:
%   holds(A, B)     A is paired with B
%   no(A, B)        A is NOT paired with B
%   one_of(As, B)   B's holder is one of the listed As
%   among(A, Bs)    A's item is one of the listed Bs

pair_up(SetA, SetB, Cs, Pairs) :-
    findall(A, set_member(SetA, A), As),
    findall(B, set_member(SetB, B), Bs),
    assign(As, Bs, Pairs),
    satisfies(Cs, Pairs).

assign([], _, []).
assign([A|As], Bs, [A-B|Rest]) :- select(B, Bs, Bs1), assign(As, Bs1, Rest).

satisfies([], _).
satisfies([holds(A, B)|Cs], P) :- member(A-B, P), satisfies(Cs, P).
satisfies([no(A, B)|Cs], P) :- \+ member(A-B, P), satisfies(Cs, P).
satisfies([one_of(As, B)|Cs], P) :- member(A, As), member(A-B, P), satisfies(Cs, P).
satisfies([among(A, Bs)|Cs], P) :- member(B, Bs), member(A-B, P), satisfies(Cs, P).

% ---- possession ------------------------------------------------------------
% has(Holder, Thing, T0, T1) facts come from held-by() and take/drop in
% the scene — who held what, and when (interval ends inclusive, like
% present_at). dynamic keeps goals from erroring in scenes that declare
% no possession at all.
:- dynamic(has/4).

% ever held / held at a moment — "who had the knife at time_of_death"
% is has_at with a time_fact:
%   ?- time_fact(time_of_death, T), has_at(X, knife, T)
has(A, B) :- has(A, B, _, _).
has_at(A, B, T) :- has(A, B, T0, T1), T0 =< T, T =< T1.

% transitive possession: the label welded to the bag rides whoever
% takes the bag ("whoever has the bag of cash knew they could get
% away" — attach the motive to the bag, and carries/2 answers the
% person). Chains are acyclic by compile guard, so this terminates.
carries(A, B) :- has(A, B).
carries(A, B) :- has(A, C), carries(C, B).
carries_at(A, B, T) :- has_at(A, B, T).
carries_at(A, B, T) :- has_at(A, C, T), carries_at(C, B, T).

% pair_up, seeded by the scene: every declared possession inside the two
% sets becomes a holds() constraint before the search runs, so the goal
% carries only the still-open clues — place a held-by() in the scene and
% watch the answers narrow.
%   ?- pair_up_scene(suspects, motives, [among(J, [a, b])], P)
pair_up_scene(SetA, SetB, Cs, Pairs) :-
    findall(holds(A, B),
            (set_member(SetA, A), set_member(SetB, B), has(A, B)),
            Known),
    append(Known, Cs, All),
    pair_up(SetA, SetB, All, Pairs).

% ---- contact ---------------------------------------------------------------
% touches(A, B, T0, T1) facts: set members in physical contact — face
% to face, or overlapping — from the scene sweep. Symmetric. dynamic
% keeps goals from erroring in scenes with no contact at all.
:- dynamic(touches/4).
touches_at(A, B, T) :- touches(A, B, T0, T1), T0 =< T, T =< T1.

% reachability through contact at a named time: conductivity, dominoes,
% train couplings. Takes a time NAME like sole/could (touches_at takes
% raw seconds). The visited list keeps contact LOOPS (a parallel
% circuit) from recursing forever.
%   ?- reaches(battery, bulb, blade_open)
reaches(A, B, TN) :- time_fact(TN, T), reach_(A, B, T, [A]).
reach_(A, B, T, _) :- touches_at(A, B, T).
reach_(A, C, T, V) :- touches_at(A, B, T), \+ member(B, V), reach_(B, C, T, [B|V]).

% everything reachable from A, once each — "what is powered?"
%   ?- reaches_set(battery, blade_open, Xs)
reaches_set(A, TN, Xs) :- findall(X, reaches(A, X, TN), L), sort(L, Xs).

% ---- counting --------------------------------------------------------------
% Every room in RoomSet has exactly one member of Set — the Murdle
% contract as a single certificate ("no room fails" — forall is spelled
% double negation). RoomSet is YOUR set of real puzzle rooms, so
% staging rooms and zones never enter the loop.
%   ?- one_each(weapons, rooms, found)
one_each(Set, RoomSet, TN) :-
    \+ (set_member(RoomSet, R), \+ exactly_one(Set, R, TN, _)).

% Exactly one member of Set is in room R at named time TN — and X is
% the one. The zebra certificate: one gift per house, named.
%   ?- exactly_one(gifts, house_1, solved, G)
exactly_one(Set, R, TN, X) :-
    time_fact(TN, T),
    set_member(Set, X),
    present_at(X, R, T),
    \+ (set_member(Set, Y), Y \= X, present_at(Y, R, T)).
