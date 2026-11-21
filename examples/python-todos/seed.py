"""Create (or reset) a todos database with the same eight todos every time.

    python3 seed.py data/todos.db
"""
import os
import sqlite3
import sys

TODOS = [
    ("Buy milk", 1),
    ("Write the quarterly report", 0),
    ("Call the dentist", 0),
    ("Renew passport", 0),
    ("Fix the bike", 0),
    ("Plan the offsite", 0),
    ("Book flights", 0),
    ("Water the plants", 0),
]


def seed(path):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    db = sqlite3.connect(path)
    db.executescript(
        """
        drop table if exists todos;
        create table todos (
          id integer primary key autoincrement,
          title text not null,
          done integer not null default 0
        );
        """
    )
    db.executemany("insert into todos (title, done) values (?, ?)", TODOS)
    db.commit()
    db.close()


if __name__ == "__main__":
    seed(sys.argv[1] if len(sys.argv) > 1 else "data/todos.db")
