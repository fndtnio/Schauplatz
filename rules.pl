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

% The verdict: exactly one member of the set lacks an alibi.
%   ?- sole(suspects, X, lion_enclosure, time_of_death)
sole(Set, X, R, TN) :-
    could(Set, X, R, TN),
    \+ (could(Set, Y, R, TN), Y \= X).
