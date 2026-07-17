% Schauplatz rules layer — consumed together with the scene's fact export.
%
% The scene states what IS true (rooms, adjacency, whereabouts intervals,
% sets, named times). This file states what FOLLOWS — the domain axioms.
% This starter library speaks detective; write your own vocabulary for
% machines, logistics, or whatever your scene models. The playground
% loads this file next to the facts and answers any `?- goal` statements
% in the scene against both.
%
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

% ---- counting --------------------------------------------------------------
% Exactly one member of Set is in room R at named time TN — and X is
% the one. The zebra certificate: one gift per house, named.
%   ?- exactly_one(gifts, house_1, solved, G)
exactly_one(Set, R, TN, X) :-
    time_fact(TN, T),
    set_member(Set, X),
    present_at(X, R, T),
    \+ (set_member(Set, Y), Y \= X, present_at(Y, R, T)).
