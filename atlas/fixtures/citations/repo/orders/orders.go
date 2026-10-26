package orders

import (
	"context"
	"database/sql"
	"errors"
)

// ErrOutOfStock is returned when a cart asks for more copies than the shelf holds.
var ErrOutOfStock = errors.New("orders: out of stock")

// Line is one book of a cart and the copies asked for.
type Line struct {
	BookID string
	Copies int
}

// Service takes orders: it writes them and asks the mailer for the confirmation.
type Service struct {
	DB     *sql.DB
	Mailer Mailer
}

// Place writes the order and lowers the stock in one transaction, then sends the mail.
func (s *Service) Place(ctx context.Context, email string, lines []Line) (int64, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	var id int64
	if err := tx.QueryRowContext(ctx,
		`INSERT INTO orders (email) VALUES ($1) RETURNING id`, email).Scan(&id); err != nil {
		return 0, err
	}

	for _, l := range lines {
		res, err := tx.ExecContext(ctx,
			`UPDATE books SET stock = stock - $1 WHERE id = $2 AND stock >= $1`, l.Copies, l.BookID)
		if err != nil {
			return 0, err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return 0, ErrOutOfStock
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, err
	}

	// The mail goes out before the request answers: a slow mail service slows the checkout.
	return id, s.Mailer.Confirm(ctx, email, id)
}
